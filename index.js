/**
 * Bot de Modération WhatsApp Multi-Comptes avec Baileys et Interface Web
 * Stack: Baileys, Express, SQLite, Pino
 */

import 'dotenv/config';
import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import makeWASocket, { useMultiFileAuthState, DisconnectReason, Browsers } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import { 
  initializeDatabase, 
  addWarning, 
  getWarningCount, 
  resetWarnings,
  getBotMode,
  setBotMode,
  isSudo,
  addSudo,
  removeSudo,
  getSudoList,
  isAntiLinkEnabled,
  setAntiLinkEnabled,
  allowLinkUser,
  disallowLinkUser,
  isLinkAllowed,
  getAllowedLinkUsers
} from './db.js';
import { isAdmin, extractMessage, containsUrl, isGroupMessage, formatMention, normalizeJid } from './utils/helpers.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SESSIONS_BASE_DIR = path.join(__dirname, 'sessions');
const LEGACY_AUTH_DIR = path.join(__dirname, 'auth_info_multi');

// Assurer l'existence du dossier racine des sessions
if (!fs.existsSync(SESSIONS_BASE_DIR)) {
  fs.mkdirSync(SESSIONS_BASE_DIR, { recursive: true });
}

// Configuration
const CONFIG = {
  port: parseInt(process.env.PORT, 10) || 3000,
  targetGroupName: process.env.TARGET_GROUP_NAME || 'Votre Nom du Groupe',
  maxWarnings: parseInt(process.env.MAX_WARNINGS, 10) || 3,
};

// Logger silencieux pour Baileys
const logger = pino({ level: 'silent' });

// Base de données
let db = null;

// Map des sessions actives: phone -> SessionObject
const sessions = new Map();

// Variables globales pour l'interface web
const activityLogs = [];
const sseClients = new Set();
let latestPairingCode = null;
let latestPairingPhone = null;

// Anti-spam tracker (messages transférés): key = "groupId:userId" -> { count: number, firstTimestamp: number }
const forwardSpamTracker = new Map();
const groupSpamCooldown = new Map();

/**
 * Détecter si un message est un message transféré (forwarded message)
 */
function isForwardedMessage(msg) {
  if (!msg || !msg.message) return false;
  let m = msg.message;
  if (m.ephemeralMessage?.message) m = m.ephemeralMessage.message;
  if (m.viewOnceMessage?.message) m = m.viewOnceMessage.message;
  if (m.viewOnceMessageV2?.message) m = m.viewOnceMessageV2.message;
  if (m.documentWithCaptionMessage?.message) m = m.documentWithCaptionMessage.message;

  const content = m.extendedTextMessage 
    || m.imageMessage 
    || m.videoMessage 
    || m.audioMessage 
    || m.documentMessage 
    || m.stickerMessage 
    || m.contactMessage 
    || m.contactsArrayMessage;

  if (content?.contextInfo?.isForwarded) return true;
  if (content?.contextInfo?.forwardingScore && content.contextInfo.forwardingScore > 0) return true;
  return false;
}

/**
 * Ajouter un log en mémoire et notifier l'interface web via SSE
 */
function logActivity(message, logType = 'info') {
  const timestamp = new Date().toLocaleTimeString();
  const formattedMsg = `[${timestamp}] ${message}`;
  console.log(formattedMsg);

  activityLogs.push(formattedMsg);
  if (activityLogs.length > 60) {
    activityLogs.shift();
  }

  broadcastSSE({
    type: 'log',
    message,
    logType,
  });
}

/**
 * Notifier tous les clients SSE connectés
 */
function broadcastSSE(data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch (_) {
      sseClients.delete(client);
    }
  }
}

/**
 * Récupérer la liste de tous les comptes pour l'API
 */
async function getAllAccountsData() {
  const accountsList = [];

  for (const [phone, session] of sessions.entries()) {
    let groupsCount = 0;
    if (session.sock && session.status === 'connected') {
      try {
        const groups = await session.sock.groupFetchAllParticipating().catch(() => ({}));
        groupsCount = Object.keys(groups).length;
      } catch (_) {}
    }

    accountsList.push({
      phone: `+${phone}`,
      name: session.user?.name || session.name || 'Bot WhatsApp',
      status: session.status || 'disconnected',
      connectedAt: session.connectedAt,
      groupsCount: groupsCount,
    });
  }

  return accountsList;
}

/**
 * Migrer l'ancienne session 'auth_info_multi' vers 'sessions/<phone>' si présente
 */
function migrateLegacySession() {
  try {
    const credsPath = path.join(LEGACY_AUTH_DIR, 'creds.json');
    if (fs.existsSync(credsPath)) {
      const creds = JSON.parse(fs.readFileSync(credsPath, 'utf-8'));
      if (creds?.me?.id) {
        const phone = creds.me.id.split('@')[0].split(':')[0];
        const targetDir = path.join(SESSIONS_BASE_DIR, phone);
        if (!fs.existsSync(targetDir)) {
          fs.cpSync(LEGACY_AUTH_DIR, targetDir, { recursive: true });
          logActivity(`Session existante migrée avec succès vers sessions/${phone}`);
        }
      }
    }
  } catch (err) {
    console.error('Erreur migration legacy session:', err);
  }
}

/**
 * Démarrer ou connecter une session WhatsApp pour un numéro donné
 */
async function startSession(phone, options = {}) {
  const { isNewPairing = false } = options;
  const sessionDir = path.join(SESSIONS_BASE_DIR, phone);

  if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true });
  }

  // Fermer la socket précédente si elle existait déjà
  const existingSession = sessions.get(phone);
  if (existingSession?.sock) {
    try {
      existingSession.sock.ev.removeAllListeners();
      existingSession.sock.ws?.close();
    } catch (_) {}
  }

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

  const sessionObj = {
    phone,
    sock: null,
    authState: state,
    saveCreds,
    status: isNewPairing ? 'connecting' : (state?.creds?.registered ? 'connecting' : 'disconnected'),
    pairingCode: null,
    connectedAt: existingSession?.connectedAt || null,
    user: existingSession?.user || null,
    name: state?.creds?.me?.name || 'Bot WhatsApp',
    pairingResolve: null,
    pairingReject: null,
    connectionAttempts: 0,
  };

  sessions.set(phone, sessionObj);

  logActivity(`[+${phone}] Initialisation de la socket Baileys...`);

  const sock = makeWASocket({
    auth: state,
    logger: logger,
    printQRInTerminal: false,
    mobile: false,
    browser: Browsers.ubuntu('Chrome'),
    syncFullHistory: false,
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
  });

  sessionObj.sock = sock;

  // Sauvegarde des identifiants
  sock.ev.on('creds.update', saveCreds);

  // Gestion des mises à jour de connexion
  sock.ev.on('connection.update', async (update) => {
    await handleSessionConnectionUpdate(phone, update, isNewPairing);
  });

  // Gestion des messages reçus pour la modération
  sock.ev.on('messages.upsert', async (m) => {
    await handleSessionMessages(phone, m);
  });

  // Mises à jour des groupes
  sock.ev.on('groups.update', (updates) => {
    for (const update of updates) {
      logActivity(`[+${phone}] Groupe mis à jour : ${update.id}`);
    }
  });

  return sessionObj;
}

/**
 * Gestionnaire connection.update par session
 */
async function handleSessionConnectionUpdate(phone, update, isNewPairing) {
  const session = sessions.get(phone);
  if (!session) return;

  const { connection, lastDisconnect, qr } = update;

  if (connection === 'connecting') {
    if (session.status !== 'awaiting_code') {
      session.status = 'connecting';
    }
    broadcastSSE({ type: 'session_update', phone, status: session.status });
  }

  // Si on est en cours de pairing et que le socket est prêt (QR émis)
  if (qr && isNewPairing && session.pairingResolve) {
    logActivity(`[+${phone}] Socket prêt — Génération du code de jumelage...`);
    try {
      const code = await session.sock.requestPairingCode(phone);
      if (code && session.pairingResolve) {
        session.pairingCode = code;
        session.status = 'awaiting_code';
        latestPairingCode = code;
        latestPairingPhone = phone;

        session.pairingResolve(code);
        session.pairingResolve = null;
        session.pairingReject = null;

        logActivity(`[+${phone}] Code généré avec succès : ${code}`, 'system');
        broadcastSSE({ type: 'session_update', phone, status: 'awaiting_code', code });
      }
    } catch (err) {
      logActivity(`[+${phone}] Erreur requestPairingCode: ${err.message}`, 'warn');
    }
  }

  if (connection === 'open') {
    session.connectionAttempts = 0;
    session.pairingCode = null;
    session.status = 'connected';
    session.connectedAt = new Date().toISOString();

    const currentPhone = session.sock?.user?.id ? session.sock.user.id.split('@')[0].split(':')[0] : phone;
    const currentName = session.sock?.user?.name || session.name || 'Bot WhatsApp';
    session.user = {
      id: session.sock?.user?.id || `${currentPhone}@s.whatsapp.net`,
      phone: `+${currentPhone}`,
      name: currentName,
    };

    logActivity(`✅ [+${currentPhone}] Connecté avec succès (${currentName}) !`, 'system');
    broadcastSSE({ type: 'session_update', phone, status: 'connected', user: session.user });
  }

  if (connection === 'close') {
    const statusCode = (lastDisconnect?.error instanceof Boom)
      ? lastDisconnect.error.output?.statusCode
      : lastDisconnect?.error?.output?.statusCode;

    const errorMsg = lastDisconnect?.error?.message || lastDisconnect?.error;
    const isLoggedOut = statusCode === DisconnectReason.loggedOut;

    logActivity(`[+${phone}] Connexion fermée: code ${statusCode || 'inconnu'} (${errorMsg})`, 'warn');

    if (isLoggedOut) {
      session.status = 'disconnected';
      session.pairingCode = null;
      // Nettoyer la session déconnectée
      const sDir = path.join(SESSIONS_BASE_DIR, phone);
      if (fs.existsSync(sDir)) {
        fs.rmSync(sDir, { recursive: true, force: true });
      }
      sessions.delete(phone);
      logActivity(`[+${phone}] Session supprimée suite à déconnexion sur le téléphone.`, 'warn');
      broadcastSSE({ type: 'session_deleted', phone });
    } else if (statusCode === DisconnectReason.restartRequired || statusCode === 515) {
      // Code 515: WhatsApp a validé le jumelage sur le téléphone et demande le redémarrage
      logActivity(`[+${phone}] 🎉 Code validé sur le téléphone ! Redémarrage immédiat (code 515)...`, 'system');
      session.status = 'connecting';
      setTimeout(() => {
        startSession(phone, { isNewPairing: false }).catch((err) => {
          logActivity(`[+${phone}] Erreur reconnexion après 515: ${err.message}`, 'warn');
        });
      }, 1000);
    } else if (session.authState?.creds?.registered) {
      // Reconnexion automatique pour compte déjà enregistré
      session.connectionAttempts++;
      const delay = Math.min(session.connectionAttempts * 3000, 15000);
      logActivity(`[+${phone}] Reconnexion dans ${delay / 1000}s... (tentative ${session.connectionAttempts})`);
      setTimeout(() => {
        startSession(phone, { isNewPairing: false }).catch(() => {});
      }, delay);
    } else if (session.status === 'awaiting_code') {
      logActivity(`[+${phone}] En attente de saisie du code sur le téléphone...`);
    } else {
      session.status = 'disconnected';
      broadcastSSE({ type: 'session_update', phone, status: 'disconnected' });
    }
  }
}

/**
 * Traitement des messages entrants et modération
 */
async function handleSessionMessages(botPhone, m) {
  const session = sessions.get(botPhone);
  if (!session || session.status !== 'connected' || !m.messages) return;

  const sock = session.sock;
  if (!sock) return;

  try {
    for (const msg of m.messages) {
      if (!msg.message) continue;

      const jid = msg.key.remoteJid;
      if (!jid || jid === 'status@broadcast') continue;

      const isGroup = isGroupMessage(jid);
      const isFromMe = Boolean(msg.key.fromMe);

      const rawSender = isGroup
        ? (msg.key.participant || msg.participant || (isFromMe ? sock?.user?.id : null))
        : jid;

      if (!rawSender) continue;
      const senderId = normalizeJid(rawSender);

      const messageText = extractMessage(msg) || '';
      const trimmedText = messageText.trim();
      const lowerText = trimmedText.toLowerCase();

      if (trimmedText) {
        logActivity(`[+${botPhone}] [${isGroup ? 'Groupe' : 'Privé'} | ${isFromMe ? 'Moi' : senderId.split('@')[0]}]: "${trimmedText}"`);
      }

      let groupData = null;
      let senderIsAdmin = isFromMe;

      if (isGroup) {
        try {
          groupData = await sock.groupMetadata(jid);
          if (!senderIsAdmin) {
            senderIsAdmin = isAdmin(senderId, groupData);
          }
        } catch (err) {
          logActivity(`Avertissement groupMetadata: ${err.message}`, 'warn');
        }

        const senderIsSudoEarly = isFromMe || isSudo(senderId);

        // 1. Module Anti-Lien
        if (!isFromMe && !senderIsAdmin && !senderIsSudoEarly && containsUrl(messageText)) {
          const antilinkActive = isAntiLinkEnabled(jid);
          const userAllowed = isLinkAllowed(jid, senderId);
          if (antilinkActive && !userAllowed) {
            await handleAntiLink(sock, jid, senderId, msg.key.id, groupData);
          }
        }

        // 2. Module Anti-Contact
        let mContent = msg.message;
        if (mContent.ephemeralMessage?.message) mContent = mContent.ephemeralMessage.message;
        if (mContent.viewOnceMessage?.message) mContent = mContent.viewOnceMessage.message;
        const isContact = Boolean(mContent.contactMessage || mContent.contactsArrayMessage);
        if (!isFromMe && !senderIsAdmin && !senderIsSudoEarly && isContact) {
          await handleAntiContact(sock, jid, senderId, msg.key.id, groupData);
        }

        // 3. Module Anti-Spam (Transfert de plus de 8 messages vers le groupe)
        if (!isFromMe && isForwardedMessage(msg)) {
          const now = Date.now();
          const trackKey = `${jid}:${senderId}`;
          const lastGroupTrigger = groupSpamCooldown.get(jid) || 0;

          if (now - lastGroupTrigger > 20000) {
            let tracker = forwardSpamTracker.get(trackKey);
            if (!tracker || (now - tracker.firstTimestamp > 15000)) {
              tracker = { count: 1, firstTimestamp: now };
            } else {
              tracker.count += 1;
            }
            forwardSpamTracker.set(trackKey, tracker);

            if (tracker.count > 8) {
              forwardSpamTracker.delete(trackKey);
              groupSpamCooldown.set(jid, now);
              await handleForwardSpam(sock, jid, senderId, groupData);
            }
          }
        }
      } else {
        senderIsAdmin = true;
      }

      if (!trimmedText) continue;

      // 3. Commandes
      const isCmd = (name) => lowerText === `!${name}` || lowerText === `.${name}` || lowerText === `/${name}`;
      const startsWithCmd = (name) => lowerText.startsWith(`!${name}`) || lowerText.startsWith(`.${name}`) || lowerText.startsWith(`/${name}`);
      const isPrefixCommand = lowerText.startsWith('.') || lowerText.startsWith('!') || lowerText.startsWith('/');

      const senderIsSudo = isFromMe || isSudo(senderId);
      const botMode = getBotMode();

      // Vérification du Mode Privé (Private Mode): seuls le bot et les sudos peuvent exécuter des commandes
      if (isPrefixCommand && botMode === 'private' && !senderIsSudo) {
        await reactToMessage(sock, jid, msg.key, '🔒');
        await sock.sendMessage(jid, {
          text: `⎔⋅• ━ ╼━ ╼╃ ⌬〔 🔒 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n` +
                `       🏰 *إمـبـراطـوريـة بـاراديـس* 🏰\n` +
                `⎔⋅• ━ ╼━ ╼╃ ⌬〔 🔒 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n\n` +
                `⛔ *الـبـوت حـالـيـاً فـي الـوضـع الـخـاص (Private Mode)*\n\n` +
                `⋄ الأوامـر مـتـاحـة فـقـط لـمـالـك الـبـوت والـمـطـوريـن الـمـعـتـمـديـن (Sudo List).\n` +
                `⋄ يـمـكـن لـلـمـطـور تـفـعـيـل الـوضـع الـعـام بـأمـر : *.mode public*\n\n` +
                `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚔️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n` +
                `       🏰 *PARADIS EMPIRE* 🏰`,
          mentions: [senderId]
        });
        continue;
      }

      // Commande .status
      if (isCmd('status') || isCmd('info') || isCmd('bot') || isCmd('حالة')) {
        await reactToMessage(sock, jid, msg.key, '⚡');
        await handleStatusCommand(sock, jid, groupData, session);
        continue;
      }

      // Commande .mention / .منشن / .tagall
      if (isCmd('mention') || isCmd('منشن') || isCmd('tagall') || isCmd('الكل') ||
          startsWithCmd('mention') || startsWithCmd('منشن') || startsWithCmd('tagall') || startsWithCmd('الكل')) {
        await reactToMessage(sock, jid, msg.key, '📢');
        if (!isGroup) {
          await sock.sendMessage(jid, { text: 'ℹ️ هذه العملية تعمل فقط داخل المجموعات.' });
          continue;
        }
        if (!senderIsAdmin && !senderIsSudo) {
          await sock.sendMessage(jid, { 
            text: '⚠️ *عـذراً!* أمـر الـمـنـشـن الـجـمـاعـي مـخـصـص لـمـشـرفـي الـمـجـمـوعـة فـقـط 🛡️',
            mentions: [senderId]
          });
          continue;
        }
        await handleMentionCommand(sock, jid, messageText, groupData, senderId);
        continue;
      }

      // Commande .menu
      if (isCmd('help') || isCmd('aide') || isCmd('menu') || isCmd('اوامر') || isCmd('الاوامر')) {
        await reactToMessage(sock, jid, msg.key, '🤖');
        await handleHelpCommand(sock, jid, senderIsAdmin, senderId, session, senderIsSudo, msg);
        continue;
      }

      // Commande .regles
      if (isCmd('regles') || isCmd('rules') || isCmd('قوانين') || isCmd('القوانين')) {
        await reactToMessage(sock, jid, msg.key, '📜');
        await handleRulesCommand(sock, jid);
        continue;
      }

      // Commande .warnings
      if (startsWithCmd('warnings') || startsWithCmd('warns') || startsWithCmd('انذارات') || startsWithCmd('انذاراتي')) {
        await reactToMessage(sock, jid, msg.key, '📋');
        if (!isGroup) {
          await sock.sendMessage(jid, { text: 'ℹ️ Cette commande fonctionne uniquement dans un groupe.' });
          continue;
        }
        await handleCheckWarningsCommand(sock, jid, messageText, senderId, msg);
        continue;
      }

      // Commande .warn (Admins / Sudo)
      if ((startsWithCmd('warn ') || startsWithCmd('انذار ')) && (senderIsAdmin || senderIsSudo)) {
        await reactToMessage(sock, jid, msg.key, '⚠️');
        if (!isGroup) {
          await sock.sendMessage(jid, { text: 'ℹ️ Cette commande fonctionne uniquement dans un groupe.' });
          continue;
        }
        await handleWarnCommand(sock, jid, messageText, groupData, msg);
        continue;
      }

      // Commande .resetwarn (Admins / Sudo)
      if ((startsWithCmd('resetwarn') || startsWithCmd('تصفير')) && (senderIsAdmin || senderIsSudo)) {
        await reactToMessage(sock, jid, msg.key, '🔄');
        if (!isGroup) {
          await sock.sendMessage(jid, { text: 'ℹ️ Cette commande fonctionne uniquement dans un groupe.' });
          continue;
        }
        await handleResetWarnCommand(sock, jid, messageText, msg);
        continue;
      }

      // Commande .kick (Admins / Sudo)
      if ((startsWithCmd('kick') || startsWithCmd('طرد')) && (senderIsAdmin || senderIsSudo)) {
        await reactToMessage(sock, jid, msg.key, '🚪');
        if (!isGroup) {
          await sock.sendMessage(jid, { text: 'ℹ️ Cette commande fonctionne uniquement dans un groupe.' });
          continue;
        }
        await handleManualKickCommand(sock, jid, messageText, groupData, msg);
        continue;
      }

      // Commande .mode [public/private] (Sudo / Owner)
      if (startsWithCmd('mode') || startsWithCmd('الوضع')) {
        await reactToMessage(sock, jid, msg.key, '⚙️');
        await handleModeCommand(sock, jid, messageText, senderIsSudo);
        continue;
      }

      // Commande .sudo / .addsudo @user (Sudo / Owner)
      if (startsWithCmd('sudo') || startsWithCmd('addsudo') || startsWithCmd('ترقية_بوت')) {
        await reactToMessage(sock, jid, msg.key, '🛡️');
        await handleAddSudoCommand(sock, jid, messageText, msg, senderIsSudo);
        continue;
      }

      // Commande .delsudo @user (Sudo / Owner)
      if (startsWithCmd('delsudo') || startsWithCmd('removesudo') || startsWithCmd('حذف_مطور')) {
        await reactToMessage(sock, jid, msg.key, '🗑️');
        await handleRemoveSudoCommand(sock, jid, messageText, msg, senderIsSudo);
        continue;
      }

      // Commande .sudolist (Sudo / Owner / All)
      if (isCmd('sudolist') || isCmd('sudos') || isCmd('المطورين') || isCmd('قائمة_المطورين')) {
        await reactToMessage(sock, jid, msg.key, '👑');
        await handleSudoListCommand(sock, jid);
        continue;
      }

      // Commande .promote @user (Group Admins / Sudo)
      if (startsWithCmd('promote') || startsWithCmd('ترقية')) {
        await reactToMessage(sock, jid, msg.key, '🎖️');
        if (!isGroup) {
          await sock.sendMessage(jid, { text: 'ℹ️ هذه العملية تعمل فقط داخل المجموعات.' });
          continue;
        }
        if (!senderIsAdmin && !senderIsSudo) {
          await sock.sendMessage(jid, { text: '⚠️ *عـذراً!* هذا الأمر مخصص لمشرفي المجموعة أو مطوري البوت فقط.', mentions: [senderId] });
          continue;
        }
        await handlePromoteCommand(sock, jid, messageText, msg, groupData);
        continue;
      }

      // Commande .demoteall (Strictement réservé au compte bot lui-même)
      if (isCmd('demoteall') || startsWithCmd('demoteall') || isCmd('تنزيل_الكل') || startsWithCmd('تنزيل_الكل')) {
        await reactToMessage(sock, jid, msg.key, '🧹');
        if (!isGroup) {
          await sock.sendMessage(jid, { text: 'ℹ️ هذه العملية تعمل فقط داخل المجموعات.' });
          continue;
        }
        if (!isFromMe) {
          await sock.sendMessage(jid, { 
            text: '⛔ *عـذراً!* أمـر تـنـزيـل الـكـل مـخـصـص حـصـراً لـحـسـاب الـبـوت نـفـسـه (لا يـمـكـن اسـتـخـدامـه حـتـى مـن الـمـطـوريـن) 🛡️',
            mentions: [senderId] 
          });
          continue;
        }
        await handleDemoteAllCommand(sock, jid, groupData);
        continue;
      }

      // Commande .demote @user (Group Admins / Sudo)
      if ((startsWithCmd('demote') && !startsWithCmd('demoteall')) || (startsWithCmd('تنزيل') && !startsWithCmd('تنزيل_الكل'))) {
        await reactToMessage(sock, jid, msg.key, '⬇️');
        if (!isGroup) {
          await sock.sendMessage(jid, { text: 'ℹ️ هذه العملية تعمل فقط داخل المجموعات.' });
          continue;
        }
        if (!senderIsAdmin && !senderIsSudo) {
          await sock.sendMessage(jid, { text: '⚠️ *عـذراً!* هذا الأمر مخصص لمشرفي المجموعة أو مطوري البوت فقط.', mentions: [senderId] });
          continue;
        }
        await handleDemoteCommand(sock, jid, messageText, msg, groupData);
        continue;
      }

      // Commande .antilink [on/off] (Group Admins / Sudo)
      if (startsWithCmd('antilink') || startsWithCmd('مضاد_الروابط')) {
        await reactToMessage(sock, jid, msg.key, '🛡️');
        if (!isGroup) {
          await sock.sendMessage(jid, { text: 'ℹ️ هذه العملية تعمل فقط داخل المجموعات.' });
          continue;
        }
        await handleAntiLinkToggleCommand(sock, jid, messageText, senderIsAdmin, senderIsSudo);
        continue;
      }

      // Commande .allowlink / .allowlinks @user (Group Admins / Sudo)
      if (startsWithCmd('allowlink') || startsWithCmd('allowlinks') || startsWithCmd('سماح_روابط')) {
        await reactToMessage(sock, jid, msg.key, '🔗');
        if (!isGroup) {
          await sock.sendMessage(jid, { text: 'ℹ️ هذه العملية تعمل فقط داخل المجموعات.' });
          continue;
        }
        await handleAllowLinkCommand(sock, jid, messageText, msg, senderIsAdmin, senderIsSudo);
        continue;
      }

      // Commande .disallowlink / .dellink @user (Group Admins / Sudo)
      if (startsWithCmd('disallowlink') || startsWithCmd('dellink') || startsWithCmd('منع_روابط')) {
        await reactToMessage(sock, jid, msg.key, '🚫');
        if (!isGroup) {
          await sock.sendMessage(jid, { text: 'ℹ️ هذه العملية تعمل فقط داخل المجموعات.' });
          continue;
        }
        await handleDisallowLinkCommand(sock, jid, messageText, msg, senderIsAdmin, senderIsSudo);
        continue;
      }

      // Commande .allowedlinks / .allowlinklist (Group Admins / Sudo / All)
      if (isCmd('allowedlinks') || isCmd('allowlinklist') || isCmd('قائمة_الروابط')) {
        await reactToMessage(sock, jid, msg.key, '📋');
        if (!isGroup) {
          await sock.sendMessage(jid, { text: 'ℹ️ هذه العملية تعمل فقط داخل المجموعات.' });
          continue;
        }
        await handleAllowedLinksListCommand(sock, jid);
        continue;
      }

      // Commande .close / .lock / .قفل (Group Admins / Sudo)
      if (isCmd('close') || isCmd('lock') || isCmd('قفل') || isCmd('غلق')) {
        await reactToMessage(sock, jid, msg.key, '🔒');
        if (!isGroup) {
          await sock.sendMessage(jid, { text: 'ℹ️ هذه العملية تعمل فقط داخل المجموعات.' });
          continue;
        }
        if (!senderIsAdmin && !senderIsSudo) {
          await sock.sendMessage(jid, { text: '⚠️ *عـذراً!* هذا الأمر مخصص لمشرفي المجموعة فقط.', mentions: [senderId] });
          continue;
        }
        try {
          await sock.groupSettingUpdate(jid, 'announcement');
          await sock.sendMessage(jid, { text: '🔒 *تـم قـفـل الـمـجـمـوعـة (الـمـشـرفـيـن فـقـط يـمـكـنـهـم الإرسـال الآن)*' });
        } catch (lockErr) {
          await sock.sendMessage(jid, { text: `❌ تعذر قفل المجموعة: ${lockErr.message}` });
        }
        continue;
      }

      // Commande .open / .unlock / .فتح (Group Admins / Sudo)
      if (isCmd('open') || isCmd('unlock') || isCmd('فتح')) {
        await reactToMessage(sock, jid, msg.key, '🔓');
        if (!isGroup) {
          await sock.sendMessage(jid, { text: 'ℹ️ هذه العملية تعمل فقط داخل المجموعات.' });
          continue;
        }
        if (!senderIsAdmin && !senderIsSudo) {
          await sock.sendMessage(jid, { text: '⚠️ *عـذراً!* هذا الأمر مخصص لمشرفي المجموعة فقط.', mentions: [senderId] });
          continue;
        }
        try {
          await sock.groupSettingUpdate(jid, 'not_announcement');
          await sock.sendMessage(jid, { text: '🔓 *تـم فـتـح الـمـجـمـوعـة (الـجـمـيـع يـمـكـنـهـم الإرسـال الآن)*' });
        } catch (openErr) {
          await sock.sendMessage(jid, { text: `❌ تعذر فتح المجموعة: ${openErr.message}` });
        }
        continue;
      }

      // 4. Commande inconnue / inexistante (ex: .xyz)
      // "si quelqu un utilise . avec commnde qui n existe pas ile repond avec (هدشي واللهم كين) avec le audio Shubady"
      if (isPrefixCommand && trimmedText.length > 1 && !trimmedText.startsWith('..') && !trimmedText.startsWith('...')) {
        await reactToMessage(sock, jid, msg.key, '❓');
        await sock.sendMessage(jid, { 
          text: 'هدشي واللهم كين' 
        }, { quoted: msg });

        const opusPath = path.join(__dirname, 'Media', 'Shubady.opus');
        const mpegPath = path.join(__dirname, 'Media', 'Shubady.mpeg');

        if (fs.existsSync(opusPath)) {
          try {
            await sock.sendMessage(jid, {
              audio: fs.readFileSync(opusPath),
              mimetype: 'audio/ogg; codecs=opus',
              ptt: true
            }, { quoted: msg });
          } catch (audioErr) {
            console.error('Erreur envoi audio Shubady opus:', audioErr);
          }
        } else if (fs.existsSync(mpegPath)) {
          try {
            await sock.sendMessage(jid, {
              audio: fs.readFileSync(mpegPath),
              mimetype: 'audio/mp4',
              ptt: false
            }, { quoted: msg });
          } catch (audioErr) {
            console.error('Erreur envoi audio Shubady mpeg:', audioErr);
          }
        }
        continue;
      }
    }
  } catch (error) {
    console.error('Erreur traitement messages:', error);
    logActivity(`Erreur traitement messages: ${error.message}`, 'warn');
  }
}

/**
 * Fonctions utilitaires pour messages et commandes
 */

/**
 * Envoyer une réaction emoji sur un message spécifique (ex: 🤖 sur .menu)
 */
async function reactToMessage(sock, jid, msgKey, emoji) {
  try {
    if (!emoji || !msgKey || !sock) return;
    await sock.sendMessage(jid, {
      react: { text: emoji, key: msgKey }
    });
  } catch (err) {
    // Réaction optionnelle, ne bloque pas le flux
  }
}

/**
 * Extraire l'ID de l'utilisateur ciblé (soit par @mention, soit par réponse/citation de son message)
 */
function extractTargetUser(messageText, msg) {
  // 1. Participant du message cité en réponse
  const quotedParticipant = msg?.message?.extendedTextMessage?.contextInfo?.participant;
  if (quotedParticipant) {
    return normalizeJid(quotedParticipant);
  }
  // 2. Mention @ dans le texte
  const match = messageText.match(/@(\d+)/);
  if (match) {
    return match[1] + '@s.whatsapp.net';
  }
  // 3. Mention JID dans contextInfo
  const mentionedJid = msg?.message?.extendedTextMessage?.contextInfo?.mentionedJid;
  if (Array.isArray(mentionedJid) && mentionedJid.length > 0) {
    return normalizeJid(mentionedJid[0]);
  }
  return null;
}

/**
 * Vérifier si le compte bot est admin dans le groupe
 */
function isBotAdmin(sock, groupData) {
  if (!groupData || !groupData.participants) return false;
  const botRaw = sock?.user?.id;
  if (!botRaw) return false;
  const botNumber = botRaw.split('@')[0].split(':')[0];
  const botParticipant = groupData.participants.find(p => {
    const pId = p.id || '';
    const pJid = p.jid || '';
    return pId.includes(botNumber) || pJid.includes(botNumber);
  });
  return botParticipant?.admin === 'admin' || botParticipant?.admin === 'superadmin';
}

/**
 * Fonctions de modération
 */
async function handleAntiLink(sock, jid, senderId, messageId, groupData) {
  try {
    // 1. Supprimer le message contenant le lien en tant qu'admin
    try {
      await sock.sendMessage(jid, { 
        delete: { 
          remoteJid: jid, 
          fromMe: false, 
          id: messageId, 
          participant: senderId 
        } 
      });
    } catch (delErr) {
      logActivity(`Échec suppression lien: ${delErr.message}`, 'warn');
    }

    const newWarningCount = addWarning(jid, senderId);
    const senderNumber = senderId.split('@')[0].split(':')[0];

    // Récupérer les admins du groupe pour les mentionner
    let currentGroupData = groupData;
    if (!currentGroupData || !currentGroupData.participants) {
      currentGroupData = await sock.groupMetadata(jid).catch(() => null);
    }
    const adminParticipants = currentGroupData?.participants?.filter(p => p.admin === 'admin' || p.admin === 'superadmin') || [];
    const allMentions = new Set([senderId]);
    const adminTags = [];

    for (const adm of adminParticipants) {
      const rawJid = adm.id || adm.jid;
      if (rawJid) {
        allMentions.add(rawJid);
        if (adm.jid) allMentions.add(adm.jid);
        if (adm.id) allMentions.add(adm.id);
        const admNum = (adm.jid || adm.id).split('@')[0].split(':')[0];
        adminTags.push(`@${admNum}`);
      }
    }

    // Message demandé: شكدير؟ سارق أعضاء؟ ابلع انذار 1/3 + tag admins
    let notificationText = `⚠️ @${senderNumber}\n*شكدير؟ سارق أعضاء؟ ابلع انذار ${newWarningCount}/${CONFIG.maxWarnings}*`;
    if (adminTags.length > 0) {
      notificationText += `\n\n👑 *تـنـبـيـه لـلـمـشـرفـيـن* : ${adminTags.join(' ')}`;
    }

    if (newWarningCount >= CONFIG.maxWarnings) {
      try {
        await sock.groupParticipantsUpdate(jid, [senderId], 'remove');
      } catch (rmErr) {
        logActivity(`Échec expulsion lien ${senderId}: ${rmErr.message}`, 'warn');
      }
      resetWarnings(jid, senderId);
      notificationText += `\n\n❌ *تـم طـرد @${senderNumber} مـن الـمـجـمـوعـة لـتـجـاوز الـحـد الأقـصـى لـلإنـذارات.*`;
    }

    await sock.sendMessage(jid, { 
      text: notificationText, 
      mentions: Array.from(allMentions).filter(Boolean) 
    });
    logActivity(`[AntiLink] Lien supprimé et warn #${newWarningCount}/${CONFIG.maxWarnings} pour ${senderNumber}`);

    // 2. Envoyer l'audio shadooh
    const opusPath = path.join(__dirname, 'Media', 'shadooh.opus');
    const mp3Path = path.join(__dirname, 'Media', 'shadooh.mp3');

    if (fs.existsSync(opusPath)) {
      try {
        await sock.sendMessage(jid, {
          audio: fs.readFileSync(opusPath),
          mimetype: 'audio/ogg; codecs=opus',
          ptt: true
        });
      } catch (audioErr) {
        logActivity(`Échec envoi audio anti-link opus: ${audioErr.message}`, 'warn');
      }
    } else if (fs.existsSync(mp3Path)) {
      try {
        await sock.sendMessage(jid, {
          audio: fs.readFileSync(mp3Path),
          mimetype: 'audio/mp4',
          ptt: false
        });
      } catch (audioErr) {
        logActivity(`Échec envoi audio anti-link mp3: ${audioErr.message}`, 'warn');
      }
    }
  } catch (err) {
    console.error('Erreur anti-lien:', err);
  }
}

async function handleAntiContact(sock, jid, senderId, messageId, groupData) {
  try {
    // Supprimer la fiche contact en tant qu'admin
    try {
      await sock.sendMessage(jid, { 
        delete: { 
          remoteJid: jid, 
          fromMe: false, 
          id: messageId, 
          participant: senderId 
        } 
      });
    } catch (delErr) {
      logActivity(`Échec suppression contact: ${delErr.message}`, 'warn');
    }

    const newWarningCount = addWarning(jid, senderId);
    const senderNumber = senderId.split('@')[0].split(':')[0];

    // Format demandé: تاشو هه كيباني ب جهة اتصال وااع علي قديم ابلع انذار 1/2
    let notificationText = `📵 @${senderNumber}\n*تاشو هه كيباني ب جهة اتصال وااع علي قديم ابلع انذار ${newWarningCount}/${CONFIG.maxWarnings}*`;

    if (newWarningCount >= CONFIG.maxWarnings) {
      try {
        await sock.groupParticipantsUpdate(jid, [senderId], 'remove');
      } catch (rmErr) {
        logActivity(`Échec expulsion contact ${senderId}: ${rmErr.message}`, 'warn');
      }
      resetWarnings(jid, senderId);
      notificationText += `\n\n❌ *تـم طـرد @${senderNumber} مـن الـمـجـمـوعـة لـتـجـاوز الـحـد الأقـصـى لـلإنـذارات.*`;
    }

    await sock.sendMessage(jid, { text: notificationText, mentions: [senderId] });
    logActivity(`[AntiContact] Contact supprimé et warn #${newWarningCount}/${CONFIG.maxWarnings} pour ${senderNumber}`);
  } catch (err) {
    console.error('Erreur anti-contact:', err);
  }
}

/**
 * Module Anti-Spam: Transfert de plus de 8 messages vers le groupe
 * Ferme le groupe, rétrograde le spammer s'il est admin, mentionne les admins et envoie l'audio Sktona
 */
async function handleForwardSpam(sock, jid, senderId, groupData) {
  try {
    const senderNumber = senderId.split('@')[0].split(':')[0];
    logActivity(`[AntiSpam] Détection spam messages transférés (>8) de @${senderNumber} dans ${jid}`, 'warn');

    let currentGroupData = groupData;
    if (!currentGroupData || !currentGroupData.participants) {
      currentGroupData = await sock.groupMetadata(jid).catch(() => null);
    }

    // 1. Fermer le groupe (Admins Only)
    try {
      await sock.groupSettingUpdate(jid, 'announcement');
      logActivity(`[AntiSpam] Groupe ${jid} fermé (announcement mode).`);
    } catch (lockErr) {
      logActivity(`[AntiSpam] Échec fermeture groupe: ${lockErr.message}`, 'warn');
    }

    // 2. Si le spammer est admin, lui retirer l'admin et le rendre membre régulier
    let wasAdmin = false;
    const spammerParticipant = currentGroupData?.participants?.find(p => {
      const pNum = (p.id || p.jid || '').split('@')[0].split(':')[0];
      return pNum === senderNumber;
    });

    if (spammerParticipant && (spammerParticipant.admin === 'admin' || spammerParticipant.admin === 'superadmin')) {
      wasAdmin = true;
      const jidToDemote = spammerParticipant.id || spammerParticipant.jid || senderId;
      try {
        await sock.groupParticipantsUpdate(jid, [jidToDemote], 'demote');
        logActivity(`[AntiSpam] Spammer @${senderNumber} dégradé de admin à membre.`);
      } catch (demoteErr) {
        logActivity(`[AntiSpam] Échec dégradation spammer: ${demoteErr.message}`, 'warn');
      }
    }

    // 3. Récupérer les admins du groupe pour les taguer
    const adminParticipants = currentGroupData?.participants?.filter(p => {
      if (p.admin !== 'admin' && p.admin !== 'superadmin') return false;
      const pNum = (p.id || p.jid || '').split('@')[0].split(':')[0];
      return pNum !== senderNumber;
    }) || [];

    const allMentions = new Set([senderId]);
    const adminTags = [];

    for (const adm of adminParticipants) {
      const rawJid = adm.id || adm.jid;
      if (rawJid) {
        allMentions.add(rawJid);
        if (adm.jid) allMentions.add(adm.jid);
        if (adm.id) allMentions.add(adm.id);
        const admNum = (adm.jid || adm.id).split('@')[0].split(':')[0];
        adminTags.push(`@${admNum}`);
      }
    }

    // 4. Message demandé : ياك أ زين؟؟ كتسبامي؟؟ جيلااااااااااااااااااال لغي لحبهم الحسبة
    let spamText = `⎔⋅• ━ ╼━ ╼╃ ⌬〔 🚨 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
    spamText += `       🏰 *إمـبـراطـوريـة بـاراديـس* 🏰\n`;
    spamText += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 🚨 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n\n`;
    spamText += `*ياك أ زين؟؟ كتسبامي؟؟ جيلااااااااااااااااااال لغي لحبهم الحسبة* 🚨🔒\n\n`;
    spamText += `⋄ الـعـضـو : @${senderNumber}\n`;
    spamText += `⋄ الإجـراء : تـم قـفـل الـمـجـمـوعـة تـلـقـائـيـاً (الـمـشـرفـيـن فـقـط)${wasAdmin ? '\n⋄ تـم تـجـريـد الـعـضـو مـن صـلاحـيـات الإشـراف ⬇️' : ''}\n\n`;
    if (adminTags.length > 0) {
      spamText += `👑 *تـنـبـيـه لـلـمـشـرفـيـن* : ${adminTags.join(' ')}\n\n`;
    }
    spamText += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚔️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
    spamText += `       🏰 *PARADIS EMPIRE* 🏰`;

    await sock.sendMessage(jid, {
      text: spamText,
      mentions: Array.from(allMentions).filter(Boolean)
    });

    // 5. Envoyer l'audio Sktona
    const opusPath = path.join(__dirname, 'Media', 'Sktona.opus');
    const mpegPath = path.join(__dirname, 'Media', 'Sktona.mpeg');

    if (fs.existsSync(opusPath)) {
      try {
        await sock.sendMessage(jid, {
          audio: fs.readFileSync(opusPath),
          mimetype: 'audio/ogg; codecs=opus',
          ptt: true
        });
      } catch (audioErr) {
        logActivity(`Échec envoi audio anti-spam opus: ${audioErr.message}`, 'warn');
      }
    } else if (fs.existsSync(mpegPath)) {
      try {
        await sock.sendMessage(jid, {
          audio: fs.readFileSync(mpegPath),
          mimetype: 'audio/mp4',
          ptt: false
        });
      } catch (audioErr) {
        logActivity(`Échec envoi audio anti-spam mpeg: ${audioErr.message}`, 'warn');
      }
    }
  } catch (err) {
    console.error('Erreur handleForwardSpam:', err);
  }
}

async function handleWarnCommand(sock, jid, messageText, groupData, msg) {
  try {
    const targetUserId = extractTargetUser(messageText, msg);
    if (!targetUserId) {
      await sock.sendMessage(jid, { text: '❌ Syntaxe incorrecte. Exemple: .warn @numéro ou répondez au message avec .warn' });
      return;
    }

    const targetNumber = targetUserId.split('@')[0].split(':')[0];
    const targetParticipant = groupData?.participants?.find((p) => {
      const pId = p.id || '';
      const pJid = p.jid || '';
      return pId.includes(targetNumber) || pJid.includes(targetNumber);
    });

    if (!targetParticipant) {
      await sock.sendMessage(jid, { text: '❌ Utilisateur introuvable dans ce groupe.' });
      return;
    }

    const newWarningCount = addWarning(jid, targetUserId);
    const targetMention = formatMention(targetUserId);
    let responseText = `⚠️ Avertissement ajouté pour ${targetMention}. Total: ${newWarningCount}/${CONFIG.maxWarnings}`;

    if (newWarningCount >= CONFIG.maxWarnings) {
      const jidToRemove = targetParticipant.id || targetParticipant.jid || targetUserId;
      await sock.groupParticipantsUpdate(jid, [jidToRemove], 'remove');
      resetWarnings(jid, targetUserId);
      responseText += `\n\n❌ ${targetMention} a été exclu (${CONFIG.maxWarnings} avertissements atteints).`;
    }

    await sock.sendMessage(jid, { text: responseText, mentions: [targetUserId] });
    logActivity(`!warn appliqué pour ${targetUserId} (${newWarningCount}/${CONFIG.maxWarnings})`);
  } catch (err) {
    console.error('Erreur !warn:', err);
  }
}

/**
 * Commande .mention / .منشن / .tagall
 * Mentionne tous les membres 1 par 1 en séparant les admins des membres normaux
 */
async function handleMentionCommand(sock, jid, messageText, groupData, senderId) {
  try {
    let currentGroupData = groupData;
    if (!currentGroupData || !currentGroupData.participants || currentGroupData.participants.length === 0) {
      try {
        currentGroupData = await sock.groupMetadata(jid);
      } catch (err) {
        logActivity(`Erreur groupMetadata pour mention: ${err.message}`, 'warn');
      }
    }

    if (!currentGroupData || !currentGroupData.participants || currentGroupData.participants.length === 0) {
      await sock.sendMessage(jid, { text: '❌ تعذر جلب قائمة أعضاء المجموعة، يرجى المحاولة لاحقاً.' });
      return;
    }

    // Extraire le message personnalisé éventuel après la commande (.mention réunion à 20h)
    const words = messageText.trim().split(/\s+/);
    words.shift();
    const customMessage = words.join(' ').trim();

    // Séparer les admins des membres normaux
    const admins = [];
    const members = [];
    const allMentions = new Set();

    for (const p of currentGroupData.participants) {
      // Récupérer le vrai numéro de téléphone du participant
      // p.jid contient le numéro de téléphone réel (@s.whatsapp.net) même si p.id est un LID
      let phone = null;
      let primaryJid = null;

      if (p.jid && p.jid.endsWith('@s.whatsapp.net')) {
        primaryJid = p.jid;
        phone = p.jid.split('@')[0].split(':')[0];
      } else if (p.id && p.id.endsWith('@s.whatsapp.net')) {
        primaryJid = p.id;
        phone = p.id.split('@')[0].split(':')[0];
      } else if (p.phoneNumber && String(p.phoneNumber).endsWith('@s.whatsapp.net')) {
        primaryJid = p.phoneNumber;
        phone = p.phoneNumber.split('@')[0].split(':')[0];
      } else {
        // Si c'est un identifiant LID
        primaryJid = p.id || p.lid;
        phone = (p.id || p.lid || '').split('@')[0].split(':')[0];
      }

      // Ajouter tous les identifiants possibles au set pour que WhatsApp valide le tag à 100%
      if (p.id) allMentions.add(p.id);
      if (p.jid) allMentions.add(p.jid);
      if (p.lid) allMentions.add(p.lid);
      if (primaryJid) allMentions.add(primaryJid);

      const tagText = `@${phone}`;

      if (p.admin === 'admin' || p.admin === 'superadmin') {
        admins.push(tagText);
      } else {
        members.push(tagText);
      }
    }

    const totalCount = currentGroupData.participants.length;
    const groupSubject = currentGroupData.subject || 'المجموعة';

    let mentionText = `⎔⋅• ━ ╼━ ╼╃ ⌬〔 📢 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
    mentionText += `       🏰 *إمـبـراطـوريـة بـاراديـس* 🏰\n`;
    mentionText += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 📢 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n\n`;

    mentionText += `🏰 *المجموعة* : ${groupSubject}\n`;
    mentionText += `👥 *العدد الإجمالي* : ${totalCount} عضو\n`;
    if (customMessage) {
      mentionText += `💬 *الرسالة* : ${customMessage}\n`;
    }
    mentionText += `\n`;

    // 1. Section المشرفين
    mentionText += `╭───『 👑 الـمـشـرفـيـن (${admins.length}) 』───⊷\n`;
    if (admins.length > 0) {
      for (const adminTag of admins) {
        mentionText += `│ ⋄ ${adminTag}\n`;
      }
    } else {
      mentionText += `│ ⋄ لا يوجد مشرفين\n`;
    }
    mentionText += `╰─────────────────────⊷\n\n`;

    // 2. Section الأعضاء
    mentionText += `╭───『 👥 الأعـضـاء (${members.length}) 』───⊷\n`;
    if (members.length > 0) {
      for (const memberTag of members) {
        mentionText += `│ ⋄ ${memberTag}\n`;
      }
    } else {
      mentionText += `│ ⋄ لا يوجد أعضاء إضافيين\n`;
    }
    mentionText += `╰─────────────────────⊷\n\n`;

    mentionText += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚔️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
    mentionText += `       🏰 *PARADIS EMPIRE* 🏰`;

    await sock.sendMessage(jid, {
      text: mentionText,
      mentions: Array.from(allMentions).filter(Boolean),
    });

    logActivity(`[Mention] Appel général envoyé dans ${jid} (${totalCount} membres mentionnés)`);
  } catch (err) {
    console.error('Erreur handleMentionCommand:', err);
    logActivity(`Erreur mention: ${err.message}`, 'warn');
  }
}

async function handleHelpCommand(sock, jid, isAdminUser, senderId = null, session = null, senderIsSudo = false, quotedMsg = null) {
  try {
    const userPhone = session?.user?.phone || (session?.phone ? `+${session.phone}` : '');
    const botMode = getBotMode();

    let helpText = `⎔⋅• ━ ╼━ ╼╃ ⌬〔 🤖 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
    helpText += `       🏰 *إمـبـراطـوريـة بـاراديـس* 🏰\n`;
    helpText += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 🤖 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n\n`;
    helpText += `مـرحـبـاً بـك فـي الـبـوت الـرسـمـي لإمـبـراطـوريـة بـاراديـس ⚔️\n`;
    if (userPhone) {
      helpText += `📱 *رقم البوت المتصل* : ${userPhone}\n`;
    }
    helpText += `⚙️ *الـوضـع الـحـالـي* : ${botMode === 'private' ? '🔒 خـاص (Private)' : '🌍 عـام (Public)'}\n\n`;

    helpText += `╭───『 📜 أوامـر الأعـضـاء 』───⊷\n`;
    helpText += `│ ⋄ *.menu* ⇠ عـرض قـائـمـة الأوامـر 🤖\n`;
    helpText += `│ ⋄ *.status* ⇠ مـعـلـومـات وحـالـة الـبـوت ⚡\n`;
    helpText += `│ ⋄ *.regles* ⇠ قـوانـيـن الإمـبـراطـوريـة 📜\n`;
    helpText += `│ ⋄ *.warnings* ⇠ فـحـص الإنـذارات 📋\n`;
    helpText += `╰─────────────────────⊷\n\n`;

    if (isAdminUser || senderIsSudo) {
      helpText += `╭───『 ⚔️ أوامـر إدارة الـمـجـمـوعـة 』───⊷\n`;
      helpText += `│ ⋄ *.mention* ⇠ نـداء ومـنـشـن شـامـل لـكـافـة الأعـضـاء 📢\n`;
      helpText += `│ ⋄ *.open* ⇠ فـتـح الـمـجـمـوعـة (الـكـل يـرسـل) 🔓\n`;
      helpText += `│ ⋄ *.close* ⇠ قـفـل الـمـجـمـوعـة (الـمـشـرفـيـن فـقـط) 🔒\n`;
      helpText += `│ ⋄ *.promote @عضو* ⇠ تـرقـيـة عـضـو إلـى مـشـرف 🎖️\n`;
      helpText += `│ ⋄ *.demote @عضو* ⇠ تـنـزيـل مـشـرف إلـى عـضـو ⬇️\n`;
      helpText += `│ ⋄ *.demoteall* ⇠ تـنـزيـل كـافـة الـمـشـرفـيـن (حـصـري لـلـبـوت) 🧹\n`;
      helpText += `│ ⋄ *.antilink [on/off]* ⇠ تـفـعـيـل أو تـعـطـيـل مـضـاد الـروابـط 🛡️\n`;
      helpText += `│ ⋄ *.allowlink @عضو* ⇠ الـسـمـاح لـعـضـو بـإرسـال الـروابـط 🔗\n`;
      helpText += `│ ⋄ *.disallowlink @عضو* ⇠ إلـغـاء الـسـمـاح بـالـروابـط 🚫\n`;
      helpText += `│ ⋄ *.allowedlinks* ⇠ قـائـمـة الأعـضـاء الـمـسـمـوح لـهـم بـالـروابـط 📋\n`;
      helpText += `│ ⋄ *.warn @عضو* ⇠ إعـطـاء إنـذار (${CONFIG.maxWarnings} = طرد) ⚠️\n`;
      helpText += `│ ⋄ *.warnings @عضو* ⇠ فـحـص إنـذارات عـضـو 📋\n`;
      helpText += `│ ⋄ *.resetwarn @عضو* ⇠ تـصـفـيـر إنـذارات عـضـو 🔄\n`;
      helpText += `│ ⋄ *.kick @عضو* ⇠ طـرد عـضـو مـن الـمـجـمـوعـة 🚪\n`;
      helpText += `╰─────────────────────⊷\n\n`;
    }

    if (senderIsSudo) {
      helpText += `╭───『 👑 أوامـر الـمـطـوريـن والـمـالـك (Sudo) 』───⊷\n`;
      helpText += `│ ⋄ *.mode [public/private]* ⇠ تـحـويـل وضـع الـبـوت ⚙️\n`;
      helpText += `│ ⋄ *.sudo @عضو* ⇠ إضـافـة مـطـور لـقـائـمـة الـبـوت 🛡️\n`;
      helpText += `│ ⋄ *.delsudo @عضو* ⇠ حـذف مـطـور مـن الـقـائـمـة 🗑️\n`;
      helpText += `│ ⋄ *.sudolist* ⇠ عـرض قـائـمـة الـمـطـوريـن 👑\n`;
      helpText += `╰─────────────────────⊷\n\n`;
    }

    helpText += `╭───『 🛡️ أنـظـمـة الـحـمـايـة 』───⊷\n`;
    helpText += `│ ⋄ 🚫 *مـنـع الـروابـط* : حـذف فـوري + إنـذار + صـوتـيـة\n`;
    helpText += `│ ⋄ 📵 *مـنـع جـهـات الاتـصـال* : حـذف فـوري + إنـذار\n`;
    helpText += `│ ⋄ 🚨 *مـضـاد الـسـبـام* : قـفـل الـمـجـمـوعـة + إنـزال الـرتـبـة عـنـد تـحـويـل >8 رسـائـل + صـوتـيـة\n`;
    helpText += `╰─────────────────────⊷\n\n`;

    helpText += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚔️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
    helpText += `       🏰 *PARADIS EMPIRE* 🏰`;

    const mentions = senderId ? [senderId] : [];
    const menuImagePath = path.join(__dirname, 'Media', 'Menu.jpeg');
    const sendOptions = quotedMsg ? { quoted: quotedMsg } : {};

    if (fs.existsSync(menuImagePath)) {
      await sock.sendMessage(jid, {
        image: fs.readFileSync(menuImagePath),
        caption: helpText,
        mentions
      }, sendOptions);
    } else {
      await sock.sendMessage(jid, {
        text: helpText,
        mentions
      }, sendOptions);
    }
  } catch (err) {
    console.error('Erreur !help:', err);
  }
}

async function handleStatusCommand(sock, jid, groupData = null, session = null) {
  try {
    const userPhone = session?.user?.phone || (session?.phone ? `+${session.phone}` : 'Inconnu');
    const userName = session?.user?.name || session?.name || 'Bot WhatsApp';
    const groupName = groupData?.subject || 'Discussion Privée';
    const totalActive = Array.from(sessions.values()).filter(s => s.status === 'connected').length;
    const botMode = getBotMode();
    const sudoCount = getSudoList().length;

    let text = `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚡ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
    text += `       🏰 *حـالـة الـحـسـاب والـبـوت* 🏰\n`;
    text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚡ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n\n`;
    text += `📱 *الـواتـسـاب الـمـتـصـل* : ${userPhone}\n`;
    text += `👤 *اسـم الـحـسـاب* : ${userName}\n`;
    text += `⚡ *حـالـة الـخـادم* : 🟢 مـتـصـل ونـشـط 24/7\n`;
    text += `🤖 *إجمالي البوتات المتصلة* : ${totalActive} حساب\n`;
    text += `⚙️ *وضـع الـبـوت* : ${botMode === 'private' ? '🔒 خـاص (Private)' : '🌍 عـام (Public)'}\n`;
    text += `👑 *عـدد الـمـطـوريـن (Sudo)* : ${sudoCount}\n`;
    text += `🏰 *الـمـجـمـوعـة الـحـالـيـة* : ${groupName}\n`;
    text += `🛡️ *أنـظـمـة الـحـمـايـة* : مـضـاد الـروابـط + مـضـاد جـهـات الاتـصـال\n`;
    text += `⚠️ *الـحـد الأقـصـى لـلإنـذارات* : ${CONFIG.maxWarnings}\n\n`;
    text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚔️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
    text += `       🏰 *PARADIS EMPIRE* 🏰`;

    await sock.sendMessage(jid, { text });
  } catch (err) {
    console.error('Erreur !status:', err);
  }
}

async function handleRulesCommand(sock, jid) {
  try {
    let rulesText = `📜 *قـوانـيـن إمـبـراطـوريـة بـاراديـس* 📜\n`;
    rulesText += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚔️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n\n`;
    rulesText += `1️⃣ *مـمـنـوع نـشـر الـروابـط* 🚫\n`;
    rulesText += `أي رابـط خـارجـي يُـحـذف فـوراً مـع إنـذار.\n\n`;
    rulesText += `2️⃣ *مـمـنـوع جـهـات الاتـصـال* 📵\n`;
    rulesText += `مـشـاركـة بـطـاقـات الاتـصـال تـعـرضـك لـلـطـرد الـمـبـاشـر.\n\n`;
    rulesText += `3️⃣ *نـظـام الإنـذارات* ⚠️\n`;
    rulesText += `الـحـد الأقـصـى ${CONFIG.maxWarnings} إنـذارات، بـعـدهـا يـتـم الـطـرد تـلـقـائـيـاً.\n\n`;
    rulesText += `4️⃣ *الاحـتـرام والـتـقـديـر* 🤝\n`;
    rulesText += `يُـمـنـع الـسـب أو الـشـتـم، الـمـعـامـلـة بـاحـتـرام واجـبـة.\n\n`;
    rulesText += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 🌿 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
    rulesText += `_نـظـام الـحـمـايـة شـغـال 24/7_`;

    await sock.sendMessage(jid, { text: rulesText });
  } catch (err) {
    console.error('Erreur !regles:', err);
  }
}

async function handleCheckWarningsCommand(sock, jid, messageText, senderId, msg) {
  try {
    let targetUserId = extractTargetUser(messageText, msg) || senderId;

    const count = getWarningCount(jid, targetUserId);
    const targetMention = formatMention(targetUserId);

    let text = `📊 ${targetMention} possède actuellement *${count}/${CONFIG.maxWarnings}* avertissement(s).`;
    if (count === 0) {
      text += ` ✅ Dossier parfait, aucune infraction !`;
    } else {
      text += ` ⚠️ Attention : à ${CONFIG.maxWarnings} avertissements, l'expulsion est automatique.`;
    }

    await sock.sendMessage(jid, { text: text, mentions: [targetUserId] });
  } catch (err) {
    console.error('Erreur !warnings:', err);
  }
}

async function handleResetWarnCommand(sock, jid, messageText, msg) {
  try {
    const targetUserId = extractTargetUser(messageText, msg);
    if (!targetUserId) {
      await sock.sendMessage(jid, { text: '❌ Syntaxe incorrecte. Exemple : *.resetwarn @numéro* ou répondez au message avec *.resetwarn*' });
      return;
    }

    resetWarnings(jid, targetUserId);

    const targetMention = formatMention(targetUserId);
    await sock.sendMessage(jid, { 
      text: `✅ Les avertissements de ${targetMention} ont été réinitialisés à 0/${CONFIG.maxWarnings}.`,
      mentions: [targetUserId]
    });
  } catch (err) {
    console.error('Erreur !resetwarn:', err);
  }
}

async function handleManualKickCommand(sock, jid, messageText, groupData, msg) {
  try {
    const targetUserId = extractTargetUser(messageText, msg);
    if (!targetUserId) {
      await sock.sendMessage(jid, { text: '❌ Syntaxe incorrecte. Exemple : *.kick @numéro* ou répondez au message avec *.kick*' });
      return;
    }

    const targetNumber = targetUserId.split('@')[0].split(':')[0];
    const targetParticipant = groupData?.participants?.find((p) => {
      const pId = p.id || '';
      const pJid = p.jid || '';
      return pId.includes(targetNumber) || pJid.includes(targetNumber);
    });

    const targetMention = formatMention(targetUserId);
    await sock.sendMessage(jid, { text: `👋 Expulsion de ${targetMention} par un administrateur...`, mentions: [targetUserId] });
    const jidToRemove = targetParticipant?.id || targetParticipant?.jid || targetUserId;
    await sock.groupParticipantsUpdate(jid, [jidToRemove], 'remove');
    resetWarnings(jid, targetUserId);
  } catch (err) {
    console.error('Erreur !kick:', err);
  }
}

/**
 * Commande .mode [public/private]
 */
async function handleModeCommand(sock, jid, messageText, senderIsSudo) {
  try {
    if (!senderIsSudo) {
      await sock.sendMessage(jid, { 
        text: '⚠️ *عـذراً!* أمـر تـغـيـيـر وضـع الـبـوت مـخـصـص لـمـالـك الـبـوت والـمـطـوريـن (Sudo) فـقـط 🛡️' 
      });
      return;
    }

    const words = messageText.trim().split(/\s+/);
    const arg = (words[1] || '').toLowerCase();

    if (arg === 'public' || arg === 'عام') {
      setBotMode('public');
      let text = `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚙️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
      text += `       🏰 *إمـبـراطـوريـة بـاراديـس* 🏰\n`;
      text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚙️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n\n`;
      text += `🌍 *تـم تـفـعـيـل الـوضـع الـعـام (Public Mode)* 🌍\n\n`;
      text += `⋄ أصـبـح بـإمـكـان كـافـة الأعـضـاء اسـتـخـدام أوامـر الـبـوت الـمـتـاحـة.\n\n`;
      text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚔️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
      text += `       🏰 *PARADIS EMPIRE* 🏰`;
      await sock.sendMessage(jid, { text });
      logActivity(`[Mode] Changé à PUBLIC par sudo`);
      return;
    }

    if (arg === 'private' || arg === 'خاص') {
      setBotMode('private');
      let text = `⎔⋅• ━ ╼━ ╼╃ ⌬〔 🔒 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
      text += `       🏰 *إمـبـراطـوريـة بـاراديـس* 🏰\n`;
      text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 🔒 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n\n`;
      text += `🔒 *تـم تـفـعـيـل الـوضـع الـخـاص (Private Mode)* 🔒\n\n`;
      text += `⋄ لا يـمـكـن لأحـد اسـتـخـدام الـبـوت سـوى مـالـك الـبـوت وقـائـمـة الـمـطـوريـن (Sudo List) فـقـط.\n\n`;
      text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚔️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
      text += `       🏰 *PARADIS EMPIRE* 🏰`;
      await sock.sendMessage(jid, { text });
      logActivity(`[Mode] Changé à PRIVATE par sudo`);
      return;
    }

    // Afficher le mode actuel
    const currentMode = getBotMode();
    let text = `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚙️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
    text += `       🏰 *إمـبـراطـوريـة بـاراديـس* 🏰\n`;
    text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚙️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n\n`;
    text += `⚙️ *وضـع الـبـوت الـحـالـي* : ${currentMode === 'private' ? '🔒 خـاص (Private)' : '🌍 عـام (Public)'}\n\n`;
    text += `⋄ لـلـتـحـويـل إلـى الـعـام : *.mode public*\n`;
    text += `⋄ لـلـتـحـويـل إلـى الـخـاص : *.mode private*\n\n`;
    text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚔️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
    text += `       🏰 *PARADIS EMPIRE* 🏰`;
    await sock.sendMessage(jid, { text });
  } catch (err) {
    console.error('Erreur handleModeCommand:', err);
  }
}

/**
 * Commande .sudo / .addsudo @user
 */
async function handleAddSudoCommand(sock, jid, messageText, msg, senderIsSudo) {
  try {
    if (!senderIsSudo) {
      await sock.sendMessage(jid, { 
        text: '⚠️ *عـذراً!* هـذا الأمـر مـخـصـص لـمـالـك الـبـوت والـمـطـوريـن الـمـعـتـمـديـن فـقـط 🛡️' 
      });
      return;
    }

    const targetUserId = extractTargetUser(messageText, msg);
    if (!targetUserId) {
      await sock.sendMessage(jid, { 
        text: '❌ *يـرجـى تـحـديـد الـعـضـو* :\n⋄ قـم بـعـمـل مـنـشـن : *.sudo @عضو*\n⋄ أو قـم بـالـرد عـلـى رسـالـتـه بـكـتـابـة *.sudo*' 
      });
      return;
    }

    const targetNumber = targetUserId.split('@')[0].split(':')[0];
    if (isSudo(targetUserId)) {
      await sock.sendMessage(jid, { 
        text: `ℹ️ الـعـضـو @${targetNumber} مـوجـود بـالـفـعـل فـي قـائـمـة الـمـطـوريـن (Sudo).`,
        mentions: [targetUserId]
      });
      return;
    }

    addSudo(targetUserId);

    let text = `⎔⋅• ━ ╼━ ╼╃ ⌬〔 🛡️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
    text += `       🏰 *إمـبـراطـوريـة بـاراديـس* 🏰\n`;
    text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 🛡️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n\n`;
    text += `👑 *تـمـت إضـافـة مـطـور جـديـد (Sudo)* 👑\n\n`;
    text += `⋄ الـعـضـو : @${targetNumber}\n`;
    text += `⋄ الـصـلاحـيـة : اسـتـخـدام وإدارة الـبـوت فـي الـوضـعـيـن الـعـام والـخـاص.\n\n`;
    text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚔️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
    text += `       🏰 *PARADIS EMPIRE* 🏰`;

    await sock.sendMessage(jid, { text, mentions: [targetUserId] });
    logActivity(`[Sudo] @${targetNumber} ajouté aux sudos`);
  } catch (err) {
    console.error('Erreur handleAddSudoCommand:', err);
  }
}

/**
 * Commande .delsudo @user
 */
async function handleRemoveSudoCommand(sock, jid, messageText, msg, senderIsSudo) {
  try {
    if (!senderIsSudo) {
      await sock.sendMessage(jid, { 
        text: '⚠️ *عـذراً!* هـذا الأمـر مـخـصـص لـمـالـك الـبـوت والـمـطـوريـن فـقـط 🛡️' 
      });
      return;
    }

    const targetUserId = extractTargetUser(messageText, msg);
    if (!targetUserId) {
      await sock.sendMessage(jid, { 
        text: '❌ *يـرجـى تـحـديـد الـعـضـو* :\n⋄ قـم بـعـمـل مـنـشـن : *.delsudo @عضو*\n⋄ أو قـم بـالـرد عـلـى رسـالـتـه بـكـتـابـة *.delsudo*' 
      });
      return;
    }

    const targetNumber = targetUserId.split('@')[0].split(':')[0];
    removeSudo(targetUserId);

    let text = `⎔⋅• ━ ╼━ ╼╃ ⌬〔 🗑️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
    text += `       🏰 *إمـبـراطـوريـة بـاراديـس* 🏰\n`;
    text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 🗑️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n\n`;
    text += `🛡️ *تـم حـذف الـعـضـو مـن قـائـمـة الـمـطـوريـن (Sudo)* 🛡️\n\n`;
    text += `⋄ الـعـضـو : @${targetNumber}\n`;
    text += `⋄ تـم إلـغـاء صـلاحـيـة اسـتـخـدام الـبـوت فـي الـوضـع الـخـاص.\n\n`;
    text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚔️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
    text += `       🏰 *PARADIS EMPIRE* 🏰`;

    await sock.sendMessage(jid, { text, mentions: [targetUserId] });
    logActivity(`[Sudo] @${targetNumber} retiré des sudos`);
  } catch (err) {
    console.error('Erreur handleRemoveSudoCommand:', err);
  }
}

/**
 * Commande .sudolist
 */
async function handleSudoListCommand(sock, jid) {
  try {
    const sudoList = getSudoList();

    let text = `⎔⋅• ━ ╼━ ╼╃ ⌬〔 👑 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
    text += `       🏰 *إمـبـراطـوريـة بـاراديـس* 🏰\n`;
    text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 👑 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n\n`;
    text += `👑 *قـائـمـة الـمـطـوريـن الـمـعـتـمـديـن (Sudo List)* (${sudoList.length}) :\n\n`;

    if (sudoList.length === 0) {
      text += `⋄ لا يـوجـد مـطـوريـن إضـافـيـيـن حـالـيـاً.\n⋄ (مـالـك حـسـاب الـبـوت يـمـلـك الـصـلاحـيـة تـلـقـائـيـاً).\n\n`;
    } else {
      for (let i = 0; i < sudoList.length; i++) {
        const u = sudoList[i];
        const num = u.split('@')[0];
        text += `│ ${i + 1}. @${num}\n`;
      }
      text += `\n`;
    }

    text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚔️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
    text += `       🏰 *PARADIS EMPIRE* 🏰`;

    await sock.sendMessage(jid, { text, mentions: sudoList });
  } catch (err) {
    console.error('Erreur handleSudoListCommand:', err);
  }
}

/**
 * Commande .promote @user (Group Admins / Sudo)
 */
async function handlePromoteCommand(sock, jid, messageText, msg, groupData) {
  try {
    let currentGroupData = groupData;
    if (!currentGroupData || !currentGroupData.participants) {
      currentGroupData = await sock.groupMetadata(jid).catch(() => null);
    }
    if (!currentGroupData) {
      await sock.sendMessage(jid, { text: '❌ تعذر الحصول على بيانات المجموعة.' });
      return;
    }

    if (!isBotAdmin(sock, currentGroupData)) {
      await sock.sendMessage(jid, { 
        text: '❌ *فـشـل الإجـراء* : يـجـب تـرقـيـة الـبـوت مـشـرفـاً (Admin) فـي الـمـجـمـوعـة أولاً لـتـمـكـيـنـه مـن إدارة الـرتـب 🛡️' 
      });
      return;
    }

    const targetUserId = extractTargetUser(messageText, msg);
    if (!targetUserId) {
      await sock.sendMessage(jid, { 
        text: '❌ *يـرجـى تـحـديـد الـعـضـو* :\n⋄ قـم بـعـمـل مـنـشـن : *.promote @عضو*\n⋄ أو قـم بـالـرد عـلـى رسـالـتـه بـكـتـابـة *.promote*' 
      });
      return;
    }

    const targetNumber = targetUserId.split('@')[0].split(':')[0];
    const participant = currentGroupData.participants.find(p => {
      const pId = p.id || '';
      const pJid = p.jid || '';
      return pId.includes(targetNumber) || pJid.includes(targetNumber);
    });

    if (!participant) {
      await sock.sendMessage(jid, { text: '❌ الـعـضـو غـيـر مـوجـود فـي هـذه الـمـجـمـوعـة.' });
      return;
    }

    if (participant.admin === 'admin' || participant.admin === 'superadmin') {
      await sock.sendMessage(jid, { 
        text: `ℹ️ الـعـضـو @${targetNumber} مـشـرف بـالـفـعـل فـي الـمـجـمـوعـة 👑`,
        mentions: [participant.id, participant.jid || `${targetNumber}@s.whatsapp.net`].filter(Boolean)
      });
      return;
    }

    const jidToPromote = participant.id || participant.jid || `${targetNumber}@s.whatsapp.net`;
    await sock.groupParticipantsUpdate(jid, [jidToPromote], 'promote');

    let text = `⎔⋅• ━ ╼━ ╼╃ ⌬〔 🎖️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
    text += `       🏰 *إمـبـراطـوريـة بـاراديـس* 🏰\n`;
    text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 🎖️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n\n`;
    text += `👑 *تـمـت الـتـرقـيـة إلـى مـشـرف بـنـجـاح* 👑\n\n`;
    text += `⋄ الـعـضـو : @${targetNumber}\n`;
    text += `⋄ الـرتـبـة : مـشـرف الـمـجـمـوعـة (Group Admin)\n\n`;
    text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚔️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
    text += `       🏰 *PARADIS EMPIRE* 🏰`;

    await sock.sendMessage(jid, {
      text,
      mentions: [participant.id, participant.jid || `${targetNumber}@s.whatsapp.net`].filter(Boolean)
    });
    logActivity(`[Promote] @${targetNumber} promu admin dans ${jid}`);
  } catch (err) {
    console.error('Erreur handlePromoteCommand:', err);
    await sock.sendMessage(jid, { text: `❌ تـعـذر تـرقـيـة الـعـضـو : ${err.message}` });
  }
}

/**
 * Commande .demote @user (Group Admins / Sudo)
 */
async function handleDemoteCommand(sock, jid, messageText, msg, groupData) {
  try {
    let currentGroupData = groupData;
    if (!currentGroupData || !currentGroupData.participants) {
      currentGroupData = await sock.groupMetadata(jid).catch(() => null);
    }
    if (!currentGroupData) {
      await sock.sendMessage(jid, { text: '❌ تعذر الحصول على بيانات المجموعة.' });
      return;
    }

    if (!isBotAdmin(sock, currentGroupData)) {
      await sock.sendMessage(jid, { 
        text: '❌ *فـشـل الإجـراء* : يـجـب تـرقـيـة الـبـوت مـشـرفـاً (Admin) فـي الـمـجـمـوعـة أولاً 🛡️' 
      });
      return;
    }

    const targetUserId = extractTargetUser(messageText, msg);
    if (!targetUserId) {
      await sock.sendMessage(jid, { 
        text: '❌ *يـرجـى تـحـديـد الـعـضـو* :\n⋄ قـم بـعـمـل مـنـشـن : *.demote @عضو*\n⋄ أو قـم بـالـرد عـلـى رسـالـتـه بـكـتـابـة *.demote*' 
      });
      return;
    }

    const targetNumber = targetUserId.split('@')[0].split(':')[0];
    const participant = currentGroupData.participants.find(p => {
      const pId = p.id || '';
      const pJid = p.jid || '';
      return pId.includes(targetNumber) || pJid.includes(targetNumber);
    });

    if (!participant) {
      await sock.sendMessage(jid, { text: '❌ الـعـضـو غـيـر مـوجـود فـي هـذه الـمـجـمـوعـة.' });
      return;
    }

    // Protection propriétaire du groupe
    const ownerNumber = currentGroupData.owner ? currentGroupData.owner.split('@')[0].split(':')[0] : null;
    if (ownerNumber && targetNumber === ownerNumber) {
      await sock.sendMessage(jid, { text: '❌ لا يـمـكـن تـنـزيـل مـالـك / مـنـشـئ الـمـجـمـوعـة 🛡️' });
      return;
    }

    if (participant.admin !== 'admin' && participant.admin !== 'superadmin') {
      await sock.sendMessage(jid, { 
        text: `ℹ️ الـعـضـو @${targetNumber} لـيـس مـشـرفـاً بـالأسـاس.`,
        mentions: [participant.id, participant.jid || `${targetNumber}@s.whatsapp.net`].filter(Boolean)
      });
      return;
    }

    const jidToDemote = participant.id || participant.jid || `${targetNumber}@s.whatsapp.net`;
    await sock.groupParticipantsUpdate(jid, [jidToDemote], 'demote');

    let text = `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⬇️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
    text += `       🏰 *إمـبـراطـوريـة بـاراديـس* 🏰\n`;
    text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⬇️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n\n`;
    text += `📉 *تـم تـنـزيـل الـرتـبـة إلـى عـضـو* 📉\n\n`;
    text += `⋄ الـعـضـو : @${targetNumber}\n`;
    text += `⋄ تـم تـجـريـده مـن صـلاحـيـات الإشـراف بـنـجـاح.\n\n`;
    text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚔️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
    text += `       🏰 *PARADIS EMPIRE* 🏰`;

    await sock.sendMessage(jid, {
      text,
      mentions: [participant.id, participant.jid || `${targetNumber}@s.whatsapp.net`].filter(Boolean)
    });
    logActivity(`[Demote] @${targetNumber} rétrogradé membre dans ${jid}`);
  } catch (err) {
    console.error('Erreur handleDemoteCommand:', err);
    await sock.sendMessage(jid, { text: `❌ تـعـذر تـنـزيـل الـعـضـو : ${err.message}` });
  }
}

/**
 * Commande .demoteall (Strictement réservé au compte bot lui-même)
 * Rétrograde tous les administrateurs du groupe sauf le bot lui-même
 */
async function handleDemoteAllCommand(sock, jid, groupData) {
  try {
    let currentGroupData = groupData;
    if (!currentGroupData || !currentGroupData.participants) {
      currentGroupData = await sock.groupMetadata(jid).catch(() => null);
    }
    if (!currentGroupData) {
      await sock.sendMessage(jid, { text: '❌ تعذر الحصول على بيانات المجموعة.' });
      return;
    }

    if (!isBotAdmin(sock, currentGroupData)) {
      await sock.sendMessage(jid, { 
        text: '❌ *فـشـل الإجـراء* : يـجـب تـرقـيـة الـبـوت مـشـرفـاً (Admin) فـي الـمـجـمـوعـة أولاً 🛡️' 
      });
      return;
    }

    const botRaw = sock?.user?.id || '';
    const botNumber = botRaw.split('@')[0].split(':')[0];

    // Trouver tous les admins sauf le bot lui-même
    const adminsToDemote = currentGroupData.participants.filter(p => {
      const isAdm = p.admin === 'admin' || p.admin === 'superadmin';
      if (!isAdm) return false;
      const pNumber = (p.id || p.jid || '').split('@')[0].split(':')[0];
      if (botNumber && pNumber === botNumber) return false;
      return true;
    });

    if (adminsToDemote.length === 0) {
      await sock.sendMessage(jid, { text: 'ℹ️ لا يـوجـد مـشـرفـيـن آخـريـن لـتـنـزيـلـهـم (الـبـوت هـو الـمـشـرف الـوحـيـد).' });
      return;
    }

    let demotedCount = 0;
    // Rétrograder chaque admin un par un
    for (const admin of adminsToDemote) {
      const targetJid = admin.id || admin.jid;
      try {
        await sock.groupParticipantsUpdate(jid, [targetJid], 'demote');
        demotedCount++;
      } catch (err) {
        logActivity(`[DemoteAll] Échec demote pour ${targetJid}: ${err.message}`, 'warn');
      }
    }

    let text = `⎔⋅• ━ ╼━ ╼╃ ⌬〔 🧹 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
    text += `       🏰 *إمـبـراطـوريـة بـاراديـس* 🏰\n`;
    text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 🧹 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n\n`;
    text += `⚡ *تـم تـنـزيـل كـافـة الـمـشـرفـيـن بـنـجـاح* ⚡\n\n`;
    text += `⋄ عـدد الـمـشـرفـيـن الـمـنـزلـيـن : ${demotedCount} مـشـرف\n`;
    text += `⋄ تـم اسـتـثـنـاء : حـسـاب الـبـوت فـقـط 🤖👑\n\n`;
    text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚔️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
    text += `       🏰 *PARADIS EMPIRE* 🏰`;

    await sock.sendMessage(jid, { text });
    logActivity(`[DemoteAll] ${demotedCount} admins rétrogradés dans ${jid} par le bot`);
  } catch (err) {
    console.error('Erreur handleDemoteAllCommand:', err);
    await sock.sendMessage(jid, { text: `❌ تـعـذر تـنـزيـل الـمـشـرفـيـن : ${err.message}` });
  }
}

/**
 * Commande .antilink on / .antilink off
 */
async function handleAntiLinkToggleCommand(sock, jid, messageText, senderIsAdmin, senderIsSudo) {
  try {
    if (!senderIsAdmin && !senderIsSudo) {
      await sock.sendMessage(jid, { text: '⚠️ *عـذراً!* هذا الأمر مخصص لمشرفي المجموعة أو مطوري البوت فقط.' });
      return;
    }

    const words = messageText.trim().split(/\s+/);
    const arg = (words[1] || '').toLowerCase();

    if (arg === 'on' || arg === 'تشغيل' || arg === 'تفعيل') {
      setAntiLinkEnabled(jid, true);
      let text = `⎔⋅• ━ ╼━ ╼╃ ⌬〔 🛡️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
      text += `       🏰 *إمـبـراطـوريـة بـاراديـس* 🏰\n`;
      text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 🛡️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n\n`;
      text += `🛡️ *تـم تـفـعـيـل مـضـاد الـروابـط (Anti-Link ON)*\n\n`;
      text += `⋄ سـيـتـم حـذف أي رابـط تـلـقـائـيـاً وإعـطـاء إنـذار لـصـاحـبـه ⚠️.\n`;
      text += `⋄ (الـمـشـرفـيـن والأعـضـاء الـمـسـمـوح لـهـم مـسـتـثـنـون).\n\n`;
      text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚔️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
      text += `       🏰 *PARADIS EMPIRE* 🏰`;
      await sock.sendMessage(jid, { text });
      logActivity(`[AntiLink] Activé dans ${jid}`);
      return;
    }

    if (arg === 'off' || arg === 'تعطيل' || arg === 'ايقاف') {
      setAntiLinkEnabled(jid, false);
      let text = `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚠️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
      text += `       🏰 *إمـبـراطـوريـة بـاراديـس* 🏰\n`;
      text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚠️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n\n`;
      text += `⚠️ *تـم إيـقـاف مـضـاد الـروابـط (Anti-Link OFF)*\n\n`;
      text += `⋄ مـسـمـوح بـنـشـر الـروابـط حـالـيـاً داخـل هـذه الـمـجـمـوعـة.\n\n`;
      text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚔️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
      text += `       🏰 *PARADIS EMPIRE* 🏰`;
      await sock.sendMessage(jid, { text });
      logActivity(`[AntiLink] Désactivé dans ${jid}`);
      return;
    }

    // Afficher statut actuel
    const currentStatus = isAntiLinkEnabled(jid);
    let text = `⎔⋅• ━ ╼━ ╼╃ ⌬〔 🛡️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
    text += `       🏰 *إمـبـراطـوريـة بـاراديـس* 🏰\n`;
    text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 🛡️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n\n`;
    text += `🛡️ *حـالـة مـضـاد الـروابـط* : ${currentStatus ? '🟢 مـفـعـل (ON)' : '🔴 مـعـطـل (OFF)'}\n\n`;
    text += `⋄ لـلـتـفـعـيـل : *.antilink on*\n`;
    text += `⋄ لـلـتـعـطـيـل : *.antilink off*\n\n`;
    text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚔️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
    text += `       🏰 *PARADIS EMPIRE* 🏰`;
    await sock.sendMessage(jid, { text });
  } catch (err) {
    console.error('Erreur handleAntiLinkToggleCommand:', err);
  }
}

/**
 * Commande .allowlink / .allowlinks @user
 */
async function handleAllowLinkCommand(sock, jid, messageText, msg, senderIsAdmin, senderIsSudo) {
  try {
    if (!senderIsAdmin && !senderIsSudo) {
      await sock.sendMessage(jid, { text: '⚠️ *عـذراً!* هذا الأمر مخصص لمشرفي المجموعة أو مطوري البوت فقط.' });
      return;
    }

    const targetUserId = extractTargetUser(messageText, msg);
    if (!targetUserId) {
      await sock.sendMessage(jid, { 
        text: '❌ *يـرجـى تـحـديـد الـعـضـو* :\n⋄ قـم بـعـمـل مـنـشـن : *.allowlink @عضو*\n⋄ أو قـم بـالـرد عـلـى رسـالـتـه بـكـتـابـة *.allowlink*' 
      });
      return;
    }

    const targetNumber = targetUserId.split('@')[0].split(':')[0];
    allowLinkUser(jid, targetUserId);

    let text = `⎔⋅• ━ ╼━ ╼╃ ⌬〔 🔗 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
    text += `       🏰 *إمـبـراطـوريـة بـاراديـس* 🏰\n`;
    text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 🔗 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n\n`;
    text += `✅ *تـم الـسـمـاح بـالـروابـط لـلـعـضـو* 🔗\n\n`;
    text += `⋄ الـعـضـو : @${targetNumber}\n`;
    text += `⋄ أصـبـح بـإمـكـانـه نـشـر الـروابـط بـحـريـة دون حـذف أو إنـذارات.\n\n`;
    text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚔️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
    text += `       🏰 *PARADIS EMPIRE* 🏰`;

    await sock.sendMessage(jid, { text, mentions: [targetUserId] });
    logActivity(`[AllowLink] @${targetNumber} autorisé aux liens dans ${jid}`);
  } catch (err) {
    console.error('Erreur handleAllowLinkCommand:', err);
  }
}

/**
 * Commande .disallowlink / .dellink @user
 */
async function handleDisallowLinkCommand(sock, jid, messageText, msg, senderIsAdmin, senderIsSudo) {
  try {
    if (!senderIsAdmin && !senderIsSudo) {
      await sock.sendMessage(jid, { text: '⚠️ *عـذراً!* هذا الأمر مخصص لمشرفي المجموعة أو مطوري البوت فقط.' });
      return;
    }

    const targetUserId = extractTargetUser(messageText, msg);
    if (!targetUserId) {
      await sock.sendMessage(jid, { 
        text: '❌ *يـرجـى تـحـديـد الـعـضـو* :\n⋄ قـم بـعـمـل مـنـشـن : *.disallowlink @عضو*\n⋄ أو قـم بـالـرد عـلـى رسـالـتـه بـكـتـابـة *.disallowlink*' 
      });
      return;
    }

    const targetNumber = targetUserId.split('@')[0].split(':')[0];
    disallowLinkUser(jid, targetUserId);

    let text = `⎔⋅• ━ ╼━ ╼╃ ⌬〔 🚫 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
    text += `       🏰 *إمـبـراطـوريـة بـاراديـس* 🏰\n`;
    text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 🚫 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n\n`;
    text += `🚫 *تـم إلـغـاء الـسـمـاح بـالـروابـط* 🚫\n\n`;
    text += `⋄ الـعـضـو : @${targetNumber}\n`;
    text += `⋄ سـيـتـم حـذف روابـطـه ومـعـاقـبـتـه بـالإنـذار كـبـاقـي الأعـضـاء.\n\n`;
    text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚔️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
    text += `       🏰 *PARADIS EMPIRE* 🏰`;

    await sock.sendMessage(jid, { text, mentions: [targetUserId] });
    logActivity(`[DisallowLink] @${targetNumber} retiré des liens autorisés dans ${jid}`);
  } catch (err) {
    console.error('Erreur handleDisallowLinkCommand:', err);
  }
}

/**
 * Commande .allowedlinks / .allowlinklist
 */
async function handleAllowedLinksListCommand(sock, jid) {
  try {
    const list = getAllowedLinkUsers(jid);

    let text = `⎔⋅• ━ ╼━ ╼╃ ⌬〔 📋 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
    text += `       🏰 *إمـبـراطـوريـة بـاراديـس* 🏰\n`;
    text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 📋 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n\n`;
    text += `📋 *قـائـمـة الأعـضـاء الـمـسـمـوح لـهـم بـالـروابـط* (${list.length}) :\n\n`;

    if (list.length === 0) {
      text += `⋄ لا يـوجـد أعـضـاء فـي الـقـائـمـة الـبـيـضـاء حـالـيـاً.\n⋄ (الـمـشـرفـيـن مـسـتـثـنـون تـلـقـائـيـاً).\n\n`;
    } else {
      for (let i = 0; i < list.length; i++) {
        const u = list[i];
        const num = u.split('@')[0];
        text += `│ ${i + 1}. @${num}\n`;
      }
      text += `\n`;
    }

    text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚔️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
    text += `       🏰 *PARADIS EMPIRE* 🏰`;

    await sock.sendMessage(jid, { text, mentions: list });
  } catch (err) {
    console.error('Erreur handleAllowedLinksListCommand:', err);
  }
}

// ----------------------------------------------------
// Serveur Web Express & API Multi-Comptes
// ----------------------------------------------------

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/**
 * API: Liste de tous les comptes WhatsApp connectés / enregistrés
 */
app.get('/api/accounts', async (req, res) => {
  try {
    const accounts = await getAllAccountsData();
    res.json({ success: true, accounts });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * API: Obtenir le statut global et le résumé des comptes
 */
app.get('/api/status', async (req, res) => {
  const accounts = await getAllAccountsData();
  const connectedAccounts = accounts.filter(a => a.status === 'connected');
  const overallStatus = connectedAccounts.length > 0 ? 'connected' : (sessions.size > 0 ? 'connecting' : 'disconnected');

  res.json({
    version: '3.0.0-multi-account',
    status: overallStatus,
    pairingCode: latestPairingCode,
    targetGroup: CONFIG.targetGroupName,
    accountsCount: accounts.length,
    connectedCount: connectedAccounts.length,
    accounts: accounts,
    // Compatibilité ascendante pour l'interface existante
    user: connectedAccounts[0] ? {
      id: `${connectedAccounts[0].phone.replace('+', '')}@s.whatsapp.net`,
      phone: connectedAccounts[0].phone,
      name: connectedAccounts[0].name,
    } : null,
    connectedAt: connectedAccounts[0]?.connectedAt || null,
    logs: activityLogs.slice(-25),
  });
});

/**
 * API: Lier un nouveau numéro de téléphone (sans déconnecter les autres !)
 */
app.post('/api/pair', async (req, res) => {
  try {
    const { phoneNumber } = req.body;
    if (!phoneNumber) {
      return res.status(400).json({ success: false, error: 'Numéro de téléphone requis.' });
    }

    const cleanPhone = String(phoneNumber).replace(/[^0-9]/g, '');
    if (cleanPhone.length < 8 || cleanPhone.length > 15) {
      return res.status(400).json({ success: false, error: 'Numéro de téléphone invalide.' });
    }

    logActivity(`Demande de liaison pour le numéro +${cleanPhone}...`);

    // Démarrer la session pour ce numéro spécifique
    const session = await startSession(cleanPhone, { isNewPairing: true });

    // Créer la Promise pour attendre le code
    const pairingPromise = new Promise((resolve, reject) => {
      session.pairingResolve = resolve;
      session.pairingReject = reject;

      setTimeout(() => {
        if (session.pairingReject) {
          reject(new Error('Délai dépassé (30s) pour obtenir le code WhatsApp.'));
          session.pairingResolve = null;
          session.pairingReject = null;
        }
      }, 30000);
    });

    // Fallback direct après 3.5 secondes si l'événement QR n'a pas encore déclenché
    const fallbackTimer = setTimeout(async () => {
      if (session.pairingResolve && session.sock) {
        logActivity(`[+${cleanPhone}] Appel direct requestPairingCode...`);
        try {
          const directCode = await session.sock.requestPairingCode(cleanPhone);
          if (directCode && session.pairingResolve) {
            session.pairingCode = directCode;
            session.status = 'awaiting_code';
            latestPairingCode = directCode;
            latestPairingPhone = cleanPhone;
            session.pairingResolve(directCode);
            session.pairingResolve = null;
            session.pairingReject = null;
          }
        } catch (err) {
          logActivity(`[+${cleanPhone}] Tentative directe: ${err.message}`, 'warn');
        }
      }
    }, 3500);

    const code = await pairingPromise;
    clearTimeout(fallbackTimer);

    res.json({
      success: true,
      code: code,
      phoneNumber: cleanPhone,
    });
  } catch (error) {
    console.error('Erreur génération code:', error);
    logActivity(`Erreur génération code: ${error.message || error}`, 'warn');
    res.status(500).json({
      success: false,
      error: error.message || 'Échec de la génération du code de liaison.',
    });
  }
});

/**
 * API: Déconnecter un compte spécifique
 */
app.post('/api/accounts/disconnect', async (req, res) => {
  try {
    const { phoneNumber } = req.body;
    const cleanPhone = String(phoneNumber || '').replace(/[^0-9]/g, '');

    if (!cleanPhone) {
      return res.status(400).json({ success: false, error: 'Numéro de téléphone requis.' });
    }

    logActivity(`Demande de déconnexion pour le compte +${cleanPhone}...`, 'warn');

    const session = sessions.get(cleanPhone);
    if (session?.sock) {
      try { await session.sock.logout(); } catch (_) {}
      try { session.sock.ev.removeAllListeners(); session.sock.ws?.close(); } catch (_) {}
    }

    // Supprimer le dossier de session pour ce numéro
    const sDir = path.join(SESSIONS_BASE_DIR, cleanPhone);
    if (fs.existsSync(sDir)) {
      fs.rmSync(sDir, { recursive: true, force: true });
    }

    sessions.delete(cleanPhone);
    logActivity(`Compte +${cleanPhone} déconnecté et supprimé.`, 'system');
    broadcastSSE({ type: 'session_deleted', phone: cleanPhone });

    res.json({ success: true, message: `Compte +${cleanPhone} déconnecté.` });
  } catch (error) {
    console.error('Erreur déconnexion:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * API: Déconnecter (rétrocompatibilité avec l'ancien bouton)
 */
app.post('/api/disconnect', async (req, res) => {
  try {
    const { phoneNumber } = req.body || {};
    let targetPhone = phoneNumber ? String(phoneNumber).replace(/[^0-9]/g, '') : null;

    if (!targetPhone) {
      const firstPhone = sessions.keys().next().value;
      targetPhone = firstPhone;
    }

    if (!targetPhone) {
      return res.json({ success: true, message: 'Aucun compte actif.' });
    }

    const session = sessions.get(targetPhone);
    if (session?.sock) {
      try { await session.sock.logout(); } catch (_) {}
      try { session.sock.ev.removeAllListeners(); session.sock.ws?.close(); } catch (_) {}
    }

    const sDir = path.join(SESSIONS_BASE_DIR, targetPhone);
    if (fs.existsSync(sDir)) {
      fs.rmSync(sDir, { recursive: true, force: true });
    }

    sessions.delete(targetPhone);
    res.json({ success: true, message: `Compte +${targetPhone} déconnecté.` });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * API: SSE notifications temps réel
 */
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  sseClients.add(res);

  req.on('close', () => {
    sseClients.delete(res);
  });
});

/**
 * Démarrage du serveur et reconnexion automatique de toutes les sessions enregistrées
 */
async function startServer() {
  try {
    // 1. Initialiser la base SQLite
    db = await initializeDatabase();

    // 2. Migrer l'ancienne session si elle existe
    migrateLegacySession();

    // 3. Lancer le serveur HTTP
    app.listen(CONFIG.port, () => {
      console.log('\n╔════════════════════════════════════════════════════════════════╗');
      console.log('║        🤖 WHATSAPP BOT MODÉRATEUR - MULTI-COMPTES              ║');
      console.log('╠════════════════════════════════════════════════════════════════╣');
      console.log(`║ 🌐 Interface Web : http://localhost:${CONFIG.port}                     ║`);
      console.log('║ 📱 Gérez plusieurs numéros WhatsApp simultanément               ║');
      console.log('╚════════════════════════════════════════════════════════════════╝\n');
    });

    // 4. Parcourir le dossier sessions/ et reconnecter chaque compte déjà enregistré
    if (fs.existsSync(SESSIONS_BASE_DIR)) {
      const dirs = fs.readdirSync(SESSIONS_BASE_DIR, { withFileTypes: true });
      for (const d of dirs) {
        if (d.isDirectory()) {
          const phone = d.name;
          const credsFile = path.join(SESSIONS_BASE_DIR, phone, 'creds.json');
          if (fs.existsSync(credsFile)) {
            try {
              const creds = JSON.parse(fs.readFileSync(credsFile, 'utf-8'));
              if (creds.registered) {
                logActivity(`[+${phone}] Session enregistrée détectée, reconnexion automatique...`);
                await startSession(phone, { isNewPairing: false });
              }
            } catch (err) {
              logActivity(`[+${phone}] Erreur lecture creds: ${err.message}`, 'warn');
            }
          }
        }
      }
    }

    if (sessions.size === 0) {
      logActivity('Aucune session active — entrez un numéro sur la page web pour lier un compte.');
    }
  } catch (error) {
    console.error('Erreur critique au démarrage:', error);
    process.exit(1);
  }
}

// Arrêt propre
process.on('SIGINT', () => {
  logActivity('Arrêt du serveur et fermeture des connexions...');
  for (const session of sessions.values()) {
    try { session.sock?.ws?.close(); } catch (_) {}
  }
  process.exit(0);
});

startServer();
