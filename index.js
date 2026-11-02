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
import QRCode from 'qrcode';
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
  getAllowedLinkUsers,
  isAntiBotEnabled,
  setAntiBotEnabled
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
let activeQrSessionId = null;

// Anti-spam tracker (messages transférés successifs dans le groupe):
// key = jid -> Array<{ senderId: string, timestamp: number }>
const forwardSpamTracker = new Map();
const groupSpamCooldown = new Map();

// Anti-Spam Ajout de Membres (Protection Anti-Tabneed / Anti-Crash / Anti-Ban Group)
// key = `${jid}:${authorNumber}` -> Array<timestamp>
const groupAddTracker = new Map();
const addSecurityCooldown = new Map();
const BLACKLISTED_TABNEED_NUMBERS = new Set([
  '9647801266024', // Vecteur d'attaque direct extrait de bpluginwhatsap.mjs
]);

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
 * Démarrer ou connecter une session WhatsApp pour un numéro donné (ou session QR temporaire)
 */
async function startSession(phone, options = {}) {
  const { isNewPairing = false, isQrMode = false } = options;
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
    qr: null,
    isQrMode,
    connectedAt: existingSession?.connectedAt || null,
    user: existingSession?.user || null,
    name: state?.creds?.me?.name || 'Bot WhatsApp',
    pairingResolve: null,
    pairingReject: null,
    qrResolve: null,
    qrReject: null,
    connectionAttempts: 0,
  };

  sessions.set(phone, sessionObj);

  const displayName = phone.startsWith('qr_') ? phone : `+${phone}`;
  logActivity(`[${displayName}] Initialisation de la socket Baileys...`);

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

  // Protection contre le spam d'ajouts de membres (Anti-Tabneed / Anti-Crash / Anti-Ban) et Détection Anti-Bot
  sock.ev.on('group-participants.update', async (update) => {
    await handleGroupParticipantsSecurity(phone, sock, update);
    await handleAntiBotParticipantCheck(phone, sock, update);
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
    if (session.status !== 'awaiting_code' && session.status !== 'awaiting_qr') {
      session.status = 'connecting';
    }
    broadcastSSE({ type: 'session_update', phone, status: session.status });
  }

  // Émission du QR Code
  if (qr) {
    if (session.isQrMode) {
      logActivity(`[${phone}] Nouveau QR Code reçu de Baileys.`);
      try {
        const qrDataUrl = await QRCode.toDataURL(qr, {
          margin: 2,
          scale: 8,
          color: { dark: '#0a1014', light: '#ffffff' }
        });
        session.qr = qrDataUrl;
        session.status = 'awaiting_qr';
        if (session.qrResolve) {
          session.qrResolve(qrDataUrl);
          session.qrResolve = null;
          session.qrReject = null;
        }
        broadcastSSE({ type: 'session_qr', sessionId: phone, status: 'awaiting_qr', qr: qrDataUrl });
      } catch (err) {
        logActivity(`[${phone}] Erreur génération image QR: ${err.message}`, 'warn');
      }
    } else if (isNewPairing && session.pairingResolve) {
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
  }

  if (connection === 'open') {
    session.connectionAttempts = 0;
    session.pairingCode = null;
    session.qr = null;
    session.status = 'connected';
    session.connectedAt = new Date().toISOString();

    const currentPhone = session.sock?.user?.id ? session.sock.user.id.split('@')[0].split(':')[0] : phone;
    const currentName = session.sock?.user?.name || session.name || 'Bot WhatsApp';
    session.user = {
      id: session.sock?.user?.id || `${currentPhone}@s.whatsapp.net`,
      phone: `+${currentPhone}`,
      name: currentName,
    };

    // Si c'était une session QR temporaire, migrer vers sessions/${currentPhone}
    if (phone.startsWith('qr_') && currentPhone && currentPhone !== phone) {
      logActivity(`[${phone}] Scan QR réussi pour +${currentPhone} ! Enregistrement de la session...`, 'system');
      const tempDir = path.join(SESSIONS_BASE_DIR, phone);
      const targetDir = path.join(SESSIONS_BASE_DIR, currentPhone);

      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }
      if (fs.existsSync(tempDir)) {
        fs.cpSync(tempDir, targetDir, { recursive: true });
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
      }

      sessions.delete(phone);
      session.phone = currentPhone;
      sessions.set(currentPhone, session);

      try {
        const { saveCreds: newSaveCreds } = await useMultiFileAuthState(targetDir);
        session.saveCreds = newSaveCreds;
        session.sock.ev.removeAllListeners('creds.update');
        session.sock.ev.on('creds.update', newSaveCreds);
      } catch (saveErr) {
        logActivity(`[+${currentPhone}] Note saveCreds: ${saveErr.message}`);
      }

      broadcastSSE({ type: 'session_migrated', from: phone, to: currentPhone });
    }

    logActivity(`✅ [+${currentPhone}] Connecté avec succès (${currentName}) !`, 'system');
    broadcastSSE({ type: 'session_update', phone: currentPhone, status: 'connected', user: session.user });
  }

  if (connection === 'close') {
    const statusCode = (lastDisconnect?.error instanceof Boom)
      ? lastDisconnect.error.output?.statusCode
      : lastDisconnect?.error?.output?.statusCode;

    const errorMsg = lastDisconnect?.error?.message || lastDisconnect?.error;
    const isLoggedOut = statusCode === DisconnectReason.loggedOut;

    logActivity(`[${phone.startsWith('qr_') ? phone : '+' + phone}] Connexion fermée: code ${statusCode || 'inconnu'} (${errorMsg})`, 'warn');

    if (phone.startsWith('qr_')) {
      if (statusCode === DisconnectReason.restartRequired || statusCode === 515) {
        logActivity(`[${phone}] WhatsApp a validé le QR code ! Redémarrage (code 515)...`, 'system');
        setTimeout(() => {
          startSession(phone, { isNewPairing: false, isQrMode: true }).catch(() => {});
        }, 1000);
      } else {
        const sDir = path.join(SESSIONS_BASE_DIR, phone);
        if (fs.existsSync(sDir) && !session.authState?.creds?.registered) {
          try { fs.rmSync(sDir, { recursive: true, force: true }); } catch (_) {}
        }
        sessions.delete(phone);
      }
      return;
    }

    if (isLoggedOut) {
      session.status = 'disconnected';
      session.pairingCode = null;
      session.qr = null;
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
      logActivity(`[+${phone}] 🎉 Validé sur le téléphone ! Redémarrage immédiat (code 515)...`, 'system');
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
      }

      const senderIsSudoEarly = isFromMe || isSudo(senderId);

      // 0. Protection Anti-Tabneed / Anti-Crash / Anti-Ban / Commandes Malveillantes Non Autorisées
      const isTabneedCmd = (
        lowerText === 'تبنيد' || lowerText.startsWith('تبنيد ') ||
        lowerText.startsWith('.تبنيد') || lowerText.startsWith('!تبنيد') || lowerText.startsWith('/تبنيد') ||
        lowerText === 'tabneed' || lowerText.startsWith('tabneed ') ||
        lowerText.startsWith('.tabneed') || lowerText.startsWith('!tabneed') || lowerText.startsWith('/tabneed') ||
        lowerText === 'ban-group' || lowerText.startsWith('ban-group ') ||
        lowerText.startsWith('.ban-group') || lowerText.startsWith('!ban-group') || lowerText.startsWith('/ban-group') ||
        lowerText === 'ban' || lowerText.startsWith('ban ') ||
        lowerText === '.ban' || lowerText.startsWith('.ban ') ||
        lowerText === '!ban' || lowerText.startsWith('!ban ') ||
        lowerText === '/ban' || lowerText.startsWith('/ban ') ||
        lowerText === '.crash' || lowerText.startsWith('.crash ') ||
        lowerText === '.nuke' || lowerText.startsWith('.nuke ') ||
        lowerText === '.destroy' || lowerText.startsWith('.destroy ') ||
        lowerText === '.kickall' || lowerText.startsWith('.kickall ') ||
        lowerText === '.demoteall' || lowerText.startsWith('.demoteall ') ||
        lowerText === 'demoteall' || lowerText.startsWith('demoteall ')
      );

      if (!isFromMe && !senderIsSudoEarly && isTabneedCmd) {
        await handleTabneedCommandAttempt(sock, jid, senderId, msg, isGroup, groupData);
        continue;
      }

      if (isGroup) {
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

        // 3. Module Anti-Spam (Transfert de messages successifs vers le groupe - 2 fois ou plus)
        if (!isFromMe && isForwardedMessage(msg)) {
          const now = Date.now();
          const lastGroupTrigger = groupSpamCooldown.get(jid) || 0;

          if (now - lastGroupTrigger > 25000) {
            let forwards = forwardSpamTracker.get(jid) || [];
            // Garder les transferts successifs récents (dans une fenêtre de 20s)
            forwards = forwards.filter((item) => now - item.timestamp <= 20000);
            forwards.push({ senderId, timestamp: now });
            forwardSpamTracker.set(jid, forwards);

            // Dès 2 transferts successifs (2 à 8 fois ou moins, même entre personnes différentes)
            if (forwards.length >= 2) {
              const spammers = Array.from(new Set(forwards.map((f) => f.senderId)));
              forwardSpamTracker.delete(jid);
              groupSpamCooldown.set(jid, now);
              await handleForwardSpam(sock, jid, spammers, groupData);
            }
          }
        }

        // 4. Module Anti-Bot (Vérification des membres actifs du groupe en temps réel)
        if (!isFromMe && !senderIsAdmin && !senderIsSudoEarly && isAntiBotEnabled(jid)) {
          const botCheck = await checkUserHasLinkedDevices(sock, senderId);
          if (botCheck.hasLinked) {
            await executeAntiBotProcedure(sock, jid, senderId, groupData);
            continue;
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

      // Commande .rulls / .rules
      if (isCmd('rulls') || isCmd('rules') || isCmd('regles') || isCmd('قوانين') || isCmd('القوانين')) {
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
        await handleCheckWarningsCommand(sock, jid, messageText, senderId, msg, groupData);
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
        await handleResetWarnCommand(sock, jid, messageText, groupData, msg);
        continue;
      }

      // Commande .kick (Admins / Sudo)
      if (startsWithCmd('kick') || startsWithCmd('طرد')) {
        await reactToMessage(sock, jid, msg.key, '🚪');
        if (!isGroup) {
          await sock.sendMessage(jid, { text: 'ℹ️ هذه العملية تعمل فقط داخل المجموعات.' });
          continue;
        }
        if (!senderIsAdmin && !senderIsSudo) {
          await sock.sendMessage(jid, { 
            text: '⚠️ *عـذراً!* أمـر الـطـرد مـخـصـص لـمـشـرفـي الـمـجـمـوعـة فـقـط 🛡️', 
            mentions: [senderId] 
          });
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

      // Commande .antibot [on/off] (Group Admins / Sudo)
      if (startsWithCmd('antibot') || startsWithCmd('مضاد_البوتات') || lowerText === 'antibot on' || lowerText === 'antibot off') {
        await reactToMessage(sock, jid, msg.key, '🤖');
        if (!isGroup) {
          await sock.sendMessage(jid, { text: 'ℹ️ هذه العملية تعمل فقط داخل المجموعات.' });
          continue;
        }
        await handleAntiBotToggleCommand(sock, jid, messageText, senderIsAdmin, senderIsSudo);
        continue;
      }

      // Commande .scan (Group Admins / Sudo)
      if (isCmd('scan') || startsWithCmd('scan') || isCmd('فحص') || startsWithCmd('فحص') || isCmd('سكان') || startsWithCmd('سكان')) {
        await reactToMessage(sock, jid, msg.key, '🔍');
        if (!isGroup) {
          await sock.sendMessage(jid, { text: 'ℹ️ هذه العملية تعمل فقط داخل المجموعات.' });
          continue;
        }
        await handleScanCommand(sock, jid, groupData, senderIsAdmin, senderIsSudo);
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
    const senderNumber = senderId.split('@')[0].split(':')[0];

    // 1. Supprimer la fiche contact en tant qu'admin
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

    // 2. Message demandé avec mention
    const notificationText = `📵 @${senderNumber}\n*تاشو ههههههه باقي كيباني بجهة الإتصال ههه وااا على قديم ههه انا و كنعرف نباني حسن منك هبط تشم الصبابط* 🥾`;
    await sock.sendMessage(jid, { text: notificationText, mentions: [senderId] });

    // 3. Envoyer l'audio StoneSciecle
    const opusPath = path.join(__dirname, 'Media', 'StoneSciecle.opus');
    const mpegPath = path.join(__dirname, 'Media', 'StoneSciecle.mpeg');

    if (fs.existsSync(opusPath)) {
      try {
        await sock.sendMessage(jid, {
          audio: fs.readFileSync(opusPath),
          mimetype: 'audio/ogg; codecs=opus',
          ptt: true
        });
      } catch (audioErr) {
        logActivity(`Échec envoi audio anti-contact opus: ${audioErr.message}`, 'warn');
      }
    } else if (fs.existsSync(mpegPath)) {
      try {
        await sock.sendMessage(jid, {
          audio: fs.readFileSync(mpegPath),
          mimetype: 'audio/mp4',
          ptt: false
        });
      } catch (audioErr) {
        logActivity(`Échec envoi audio anti-contact mpeg: ${audioErr.message}`, 'warn');
      }
    }

    // 4. Expulser l'utilisateur directement sans avertissement (Kick direct)
    try {
      await sock.groupParticipantsUpdate(jid, [senderId], 'remove');
      logActivity(`[AntiContact] @${senderNumber} expulsé directement du groupe suite à l'envoi d'un contact.`);
    } catch (rmErr) {
      logActivity(`Échec expulsion contact @${senderNumber}: ${rmErr.message}`, 'warn');
    }

  } catch (err) {
    console.error('Erreur anti-contact:', err);
  }
}

/**
 * Module Anti-Spam: Transfert de messages successifs vers le groupe (2 fois ou plus)
 * Ferme le groupe, rétrograde les spammers s'ils sont admins, mentionne les admins et envoie l'audio Sktona
 */
async function handleForwardSpam(sock, jid, spammersInput, groupData) {
  try {
    const spammersList = Array.isArray(spammersInput) ? spammersInput : [spammersInput];
    const spammerNumbers = spammersList.map((s) => (s || '').split('@')[0].split(':')[0]);
    logActivity(`[AntiSpam] Détection spam messages transférés successifs de [${spammerNumbers.join(', ')}] dans ${jid}`, 'warn');

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

    // 2. Si un ou plusieurs spammers sont admins, leur retirer l'admin et les rendre membres réguliers
    const demotedAdmins = [];
    for (const spammerId of spammersList) {
      const spammerNumber = spammerId.split('@')[0].split(':')[0];
      const spammerParticipant = currentGroupData?.participants?.find((p) => {
        const pNum = (p.id || p.jid || '').split('@')[0].split(':')[0];
        return pNum === spammerNumber;
      });

      if (spammerParticipant && (spammerParticipant.admin === 'admin' || spammerParticipant.admin === 'superadmin')) {
        const jidToDemote = spammerParticipant.id || spammerParticipant.jid || spammerId;
        try {
          await sock.groupParticipantsUpdate(jid, [jidToDemote], 'demote');
          demotedAdmins.push(`@${spammerNumber}`);
          logActivity(`[AntiSpam] Spammer @${spammerNumber} dégradé de admin à membre.`);
        } catch (demoteErr) {
          logActivity(`[AntiSpam] Échec dégradation spammer @${spammerNumber}: ${demoteErr.message}`, 'warn');
        }
      }
    }

    // 3. Récupérer les autres admins du groupe pour les taguer
    const adminParticipants = currentGroupData?.participants?.filter((p) => {
      if (p.admin !== 'admin' && p.admin !== 'superadmin') return false;
      const pNum = (p.id || p.jid || '').split('@')[0].split(':')[0];
      return !spammerNumbers.includes(pNum);
    }) || [];

    const allMentions = new Set(spammersList);
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

    const spammerMentionsText = spammerNumbers.map((n) => `@${n}`).join(' و ');

    // 4. Message demandé : ياك أ زين؟؟ كتسبامي؟؟ جيلااااااااااااااااااال لغي لحبهم الحسبة
    let spamText = `⎔⋅• ━ ╼━ ╼╃ ⌬〔 🚨 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
    spamText += `       🏰 *إمـبـراطـوريـة بـاراديـس* 🏰\n`;
    spamText += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 🚨 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n\n`;
    spamText += `*ياك أ زين؟؟ كتسبامي؟؟ جيلااااااااااااااااااال لغي لحبهم الحسبة* 🚨🔒\n\n`;
    spamText += `⋄ الـعـضـو : ${spammerMentionsText}\n`;
    spamText += `⋄ الإجـراء : تـم قـفـل الـمـجـمـوعـة تـلـقـائـيـاً (الـمـشـرفـيـن فـقـط)${demotedAdmins.length > 0 ? `\n⋄ تـم تـجـريـد ${demotedAdmins.join(' و ')} مـن صـلاحـيـات الإشـراف ⬇️` : ''}\n\n`;
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

/**
 * Module de Défense Anti-Tabneed / Anti-Crash / Anti-Ban:
 * Interception d'une tentative de commande malveillante ou non autorisée (.ban, tabneed, etc.)
 * 1. Supprime le message
 * 2. Ferme le groupe
 * 3. Tag l'utilisateur et dit (حصلتي حصلة الكلاب)
 * 4. Envoie l'audio TomLaugh1
 * 5. Kick l'utilisateur en taguant les admins
 * 6. Rouvre le groupe
 */
async function handleTabneedCommandAttempt(sock, jid, senderId, msg, isGroup, groupData) {
  try {
    const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
    const senderNumber = senderId.split('@')[0].split(':')[0];
    logActivity(`[Anti-Ban] Tentative d'exécution de commande interdite (.ban/exploit) par @${senderNumber} dans ${jid}`, 'warn');

    // 1. Supprimer le message
    try {
      if (msg && msg.key) {
        await sock.sendMessage(jid, { delete: msg.key });
      }
    } catch (_) {}

    if (!isGroup) {
      try {
        await sock.updateBlockStatus(senderId, 'block');
      } catch (_) {}
      await sock.sendMessage(jid, {
        text: `⛔ *نـظـام الـحـمـايـة الإمـبـراطـوري* : تـم حـظـرك تـلـقـائـيـاً لـمـحـاولـة اسـتـخـدام أوامـر تـبـنـيـد مـحـظـورة.`
      }, { quoted: msg });
      return;
    }

    // 2. Fermer le groupe
    try {
      await sock.groupSettingUpdate(jid, 'announcement');
      logActivity(`[Anti-Ban] Groupe fermé d'urgence.`);
    } catch (gErr) {
      logActivity(`Échec fermeture groupe: ${gErr.message}`, 'warn');
    }

    // Résoudre l'utilisateur pour une mention propre sans LID
    const resolved = await resolveGroupParticipant(sock, jid, senderId, groupData);

    // 3. Tag l'utilisateur et dit (حصلتي حصلة الكلاب)
    await sock.sendMessage(jid, {
      text: `حصلتي حصلة الكلاب ${resolved.tag}`,
      mentions: resolved.mentions
    });

    // 4. Envoyer l'audio TomLaugh1 (Opus PTT avec fallback MPEG)
    const laugh1Opus = path.join(__dirname, 'Media', 'TomLaugh1.opus');
    const laugh1Mpeg = path.join(__dirname, 'Media', 'TomLaugh1.mpeg');
    if (fs.existsSync(laugh1Opus)) {
      try {
        await sock.sendMessage(jid, {
          audio: fs.readFileSync(laugh1Opus),
          mimetype: 'audio/ogg; codecs=opus',
          ptt: true
        });
      } catch (aErr) {
        logActivity(`Échec audio TomLaugh1 opus: ${aErr.message}`, 'warn');
      }
    } else if (fs.existsSync(laugh1Mpeg)) {
      try {
        await sock.sendMessage(jid, {
          audio: fs.readFileSync(laugh1Mpeg),
          mimetype: 'audio/mp4',
          ptt: false
        });
      } catch (aErr) {
        logActivity(`Échec audio TomLaugh1 mpeg: ${aErr.message}`, 'warn');
      }
    }

    // 5. Récupérer les admins pour mention
    let currentGroupData = groupData;
    if (!currentGroupData || !currentGroupData.participants) {
      currentGroupData = await sock.groupMetadata(jid).catch(() => null);
    }

    const botNumber = (sock.user?.id || '').split('@')[0].split(':')[0];
    const adminParticipants = currentGroupData?.participants?.filter((p) => {
      if (p.admin !== 'admin' && p.admin !== 'superadmin') return false;
      const pNum = (p.id || p.jid || '').split('@')[0].split(':')[0];
      return pNum !== resolved.phone && pNum !== botNumber;
    }) || [];

    const allMentions = new Set(resolved.mentions);
    const adminTags = [];

    for (const adm of adminParticipants) {
      const rawJid = adm.id || adm.jid;
      if (rawJid) {
        allMentions.add(rawJid);
        const admNum = (adm.jid || adm.id).split('@')[0].split(':')[0];
        adminTags.push(`@${admNum}`);
      }
    }

    // Rétrograder s'il est admin
    try {
      await sock.groupParticipantsUpdate(jid, [resolved.participant?.id || senderId], 'demote');
    } catch (_) {}

    // Expulser du groupe (Kick)
    try {
      await sock.groupParticipantsUpdate(jid, [resolved.participant?.id || senderId], 'remove');
      logActivity(`[Anti-Ban] Utilisateur ${resolved.tag} expulsé du groupe.`);
    } catch (kickErr) {
      logActivity(`[Anti-Ban] Erreur expulsion ${resolved.tag}: ${kickErr.message}`, 'warn');
    }

    // Bloquer l'attaquant sur WhatsApp (Block)
    try {
      await sock.updateBlockStatus(senderId, 'block');
    } catch (_) {}

    // Message d'alerte en taguant les admins
    let alertMsg = `⎔⋅• ━ ╼━ ╼╃ ⌬〔 🚨 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
    alertMsg += `       🏰 *إمـبـراطـوريـة بـاراديـس* 🏰\n`;
    alertMsg += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 🚨 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n\n`;
    alertMsg += `⛔ *رادار الـدفـاع: رصـد أمـر مـحـظـور (.ban / تبنيد)* ⛔\n\n`;
    alertMsg += `حـاول الـعـضـو اسـتـخـدام أوامـر مـحـظـورة، تـم تـحـيـيـده فـوراً!\n\n`;
    alertMsg += `⋄ الـعـضـو : ${resolved.tag}\n`;
    alertMsg += `⋄ الإجـراء : تـم الـطـرد (Kick) + الـحـظـر (Block) 🚫\n\n`;
    if (adminTags.length > 0) {
      alertMsg += `👑 *إشـعـار لـلإدارة والـمـشـرفـيـن* :\n${adminTags.join(' ')}\n\n`;
    }
    alertMsg += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚔️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
    alertMsg += `       🏰 *PARADIS EMPIRE DEFENSE* 🏰`;

    await sock.sendMessage(jid, {
      text: alertMsg,
      mentions: Array.from(allMentions).filter(Boolean)
    });

    // 6. Rouvrir le groupe après un court délai
    await sleep(2000);
    try {
      await sock.groupSettingUpdate(jid, 'not_announcement');
      logActivity(`[Anti-Ban] Groupe rouvert avec succès.`);
    } catch (openErr) {
      logActivity(`Échec réouverture groupe: ${openErr.message}`, 'warn');
    }

  } catch (err) {
    console.error('Erreur handleTabneedCommandAttempt:', err);
  }
}

/**
 * Module de Défense Anti-Spam Ajout de Membres (Anti-Tabneed Flood & Add-to-Group Spam)
 * Détecte les boucles d'ajouts massifs ou l'ajout de numéros blacklistés (vecteurs de ban)
 * Bloque l'attaquant, le rétrograde, l'expulse du groupe, éjecte les cibles et verrouille le groupe
 */
async function handleGroupParticipantsSecurity(botPhone, sock, update) {
  try {
    const { id: jid, participants, action, author } = update;
    if (!jid || action !== 'add' || !participants || participants.length === 0) return;

    const botNumber = (sock.user?.id || '').split('@')[0].split(':')[0];
    const authorJid = author ? normalizeJid(author) : null;
    const authorNumber = authorJid ? authorJid.split('@')[0].split(':')[0] : null;

    // Si l'auteur est le bot lui-même ou un compte sudo, ignorer
    if (!authorNumber || authorNumber === botNumber || (authorJid && isSudo(authorJid))) {
      return;
    }

    const now = Date.now();

    // 1. Vérifier si l'un des participants ajoutés est un vecteur de تبنيد blacklisté
    let hasBlacklistedTarget = false;
    for (const p of participants) {
      const pNum = (p || '').split('@')[0].split(':')[0];
      if (BLACKLISTED_TABNEED_NUMBERS.has(pNum)) {
        hasBlacklistedTarget = true;
        break;
      }
    }

    // 2. Vérifier si c'est un flood d'ajouts rapides (boucle de spam add-to-group comme bpluginwhatsap.mjs)
    const trackKey = `${jid}:${authorNumber}`;
    let addTimestamps = groupAddTracker.get(trackKey) || [];
    addTimestamps = addTimestamps.filter((t) => now - t <= 4000);
    addTimestamps.push(now);
    groupAddTracker.set(trackKey, addTimestamps);

    const isRapidAddFlood = addTimestamps.length >= 2;

    if (!hasBlacklistedTarget && !isRapidAddFlood) {
      return;
    }

    logActivity(`[Anti-Tabneed] ALERTE HAUTE SÉCURITÉ: Attaque dans ${jid} par @${authorNumber} (Cible blacklistée: ${hasBlacklistedTarget}, Flood rapide: ${isRapidAddFlood})`, 'warn');

    // Éviter le déclenchement en boucle pendant la même attaque
    const lastTrigger = addSecurityCooldown.get(trackKey) || 0;
    if (now - lastTrigger < 10000) {
      // Nettoyer immédiatement les participants ajoutés
      await sock.groupParticipantsUpdate(jid, participants, 'remove').catch(() => {});
      return;
    }
    addSecurityCooldown.set(trackKey, now);

    // 1. Bloquer l'attaquant sur WhatsApp (Block)
    try {
      await sock.updateBlockStatus(authorJid, 'block');
      logActivity(`[Anti-Tabneed] Attaquant @${authorNumber} bloqué.`);
    } catch (blockErr) {
      logActivity(`[Anti-Tabneed] Échec blocage @${authorNumber}: ${blockErr.message}`, 'warn');
    }

    // 2. Rétrograder l'attaquant s'il est admin
    try {
      await sock.groupParticipantsUpdate(jid, [authorJid], 'demote');
    } catch (_) {}

    // 3. Expulser l'attaquant du groupe (Kick)
    try {
      await sock.groupParticipantsUpdate(jid, [authorJid], 'remove');
      logActivity(`[Anti-Tabneed] Attaquant @${authorNumber} expulsé du groupe.`);
    } catch (kickErr) {
      logActivity(`[Anti-Tabneed] Échec expulsion @${authorNumber}: ${kickErr.message}`, 'warn');
    }

    // 4. Expulser les numéros cibles ajoutés par l'attaquant
    try {
      await sock.groupParticipantsUpdate(jid, participants, 'remove');
      logActivity(`[Anti-Tabneed] Cibles ${participants.join(', ')} expulsées.`);
    } catch (removeErr) {
      logActivity(`[Anti-Tabneed] Échec expulsion cibles: ${removeErr.message}`, 'warn');
    }

    // 5. Verrouiller le groupe en mode annonce (Admins Only) pour bloquer l'attaque
    try {
      await sock.groupSettingUpdate(jid, 'announcement');
      logActivity(`[Anti-Tabneed] Groupe ${jid} verrouillé pour protection.`);
    } catch (_) {}

    // 6. Récupérer les admins pour mention
    let groupData = null;
    try {
      groupData = await sock.groupMetadata(jid);
    } catch (_) {}

    const adminParticipants = groupData?.participants?.filter((p) => {
      if (p.admin !== 'admin' && p.admin !== 'superadmin') return false;
      const pNum = (p.id || p.jid || '').split('@')[0].split(':')[0];
      return pNum !== authorNumber && pNum !== botNumber;
    }) || [];

    const allMentions = new Set([authorJid]);
    const adminTags = [];

    for (const adm of adminParticipants) {
      const rawJid = adm.id || adm.jid;
      if (rawJid) {
        allMentions.add(rawJid);
        const admNum = (adm.jid || adm.id).split('@')[0].split(':')[0];
        adminTags.push(`@${admNum}`);
      }
    }

    // 7. Message d'alerte sécurité royal
    let alertMsg = `⎔⋅• ━ ╼━ ╼╃ ⌬〔 🛡️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
    alertMsg += `       🏰 *إمـبـراطـوريـة بـاراديـس* 🏰\n`;
    alertMsg += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 🚨 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n\n`;
    alertMsg += `⛔ *رادار الـدفـاع: إحـبـاط هـجـوم تـبـنـيـد مـعـادي!* ⛔\n\n`;
    alertMsg += `تـم رصـد مـحـاولـة هـجـوم سـبـام إضـافـات (Add-to-Group Spam / Tabneed Attack) لإسـقـاط الـمـجـمـوعـة!\n\n`;
    alertMsg += `⋄ الـمـهـاجـم : @${authorNumber}\n`;
    alertMsg += `⋄ الإجـراءات الـمـنـفـذة فـوراً :\n`;
    alertMsg += `  1️⃣ تـم حـظـر الـمـهـاجـم (Block) 🚫\n`;
    alertMsg += `  2️⃣ تـم طـرد الـمـهـاجـم مـن الـمـجـمـوعـة 👢\n`;
    alertMsg += `  3️⃣ تـم طـرد الأرقـام الـمـشـبـوهـة الـمـضـافـة 🧹\n`;
    alertMsg += `  4️⃣ تـم قـفـل الـمـجـمـوعـة تـلـقـائـيـاً لـحـمـايـتـهـا 🔒\n\n`;
    if (adminTags.length > 0) {
      alertMsg += `👑 *إشـعـار لـلـمـشـرفـيـن* : ${adminTags.join(' ')}\n\n`;
    }
    alertMsg += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚔️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
    alertMsg += `       🏰 *PARADIS EMPIRE SECURITY* 🏰`;

    await sock.sendMessage(jid, {
      text: alertMsg,
      mentions: Array.from(allMentions).filter(Boolean)
    });

  } catch (err) {
    console.error('Erreur handleGroupParticipantsSecurity:', err);
  }
}

/**
 * Module de Détection et Défense Anti-Bot lors de l'entrée dans le groupe
 * Si un utilisateur entre et qu'il est lié à un appareil/bot:
/**
 * Cache et Vérification de statut "Appareil Lié / Bot"
 */
const botDeviceCheckCache = new Map(); // cleanJid -> { hasLinked, count, timestamp }
const antibotCooldown = new Map(); // `${jid}:${phone}` -> timestamp

async function checkUserHasLinkedDevices(sock, userJid) {
  try {
    const cleanJid = userJid.includes('@') ? userJid : `${userJid}@s.whatsapp.net`;
    const userPhone = cleanJid.split('@')[0].split(':')[0];

    const now = Date.now();
    const cached = botDeviceCheckCache.get(cleanJid);
    if (cached && (now - cached.timestamp < 15000)) {
      return cached;
    }

    if (typeof sock.getUSyncDevices !== 'function') {
      return { hasLinked: false, count: 0 };
    }

    const devices = await sock.getUSyncDevices([cleanJid], false, false);
    let count = 0;
    let hasLinked = false;

    if (Array.isArray(devices)) {
      const linked = devices.filter((d) => {
        const devId = Number(d.device);
        return !isNaN(devId) && devId > 0;
      });

      if (linked.length >= 1) {
        hasLinked = true;
        count = linked.length;
      } else if (devices.length > 1) {
        hasLinked = true;
        count = devices.length - 1;
      }
    }

    const result = { hasLinked, count, timestamp: now };
    botDeviceCheckCache.set(cleanJid, result);
    return result;
  } catch (err) {
    logActivity(`[AntiBot] Erreur checkUserHasLinkedDevices pour ${userJid}: ${err.message}`, 'warn');
    return { hasLinked: false, count: 0 };
  }
}

/**
 * Procédure Officielle Anti-Bot:
 * 1. Fermer le groupe
 * 2. Tag l'utilisateur et dire (وينو عندو بوت)
 * 3. Envoyer l'audio TomLaugh1.opus (PTT)
 * 4. Kick l'utilisateur
 * 5. Tag les admins pour les informer
 * 6. Rouvrir le groupe
 */
async function executeAntiBotProcedure(sock, jid, targetJid, groupData) {
  try {
    const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
    const targetPhone = targetJid.split('@')[0].split(':')[0];
    const botNumber = (sock.user?.id || '').split('@')[0].split(':')[0];

    if (targetPhone === botNumber || isSudo(targetJid)) return;

    let currentGroupData = groupData;
    if (!currentGroupData || !currentGroupData.participants) {
      try {
        currentGroupData = await sock.groupMetadata(jid);
      } catch (_) {}
    }

    // Résoudre le participant
    const resolved = await resolveGroupParticipant(sock, jid, targetJid, currentGroupData);

    // Ne jamais kicker les admins ou le créateur du groupe
    const ownerJid = currentGroupData?.owner || currentGroupData?.subjectOwner || '';
    const ownerNumber = ownerJid ? ownerJid.split('@')[0].split(':')[0] : null;
    const isOwnerOrAdmin = (
      (ownerNumber && resolved.phone === ownerNumber) ||
      (resolved.participant && (resolved.participant.admin === 'admin' || resolved.participant.admin === 'superadmin'))
    );
    if (isOwnerOrAdmin) {
      logActivity(`[AntiBot] Cible ${resolved.tag} est admin/propriétaire, expulsion ignorée.`);
      return;
    }

    const coolKey = `${jid}:${resolved.phone}`;
    const lastTrigger = antibotCooldown.get(coolKey) || 0;
    if (Date.now() - lastTrigger < 10000) return;
    antibotCooldown.set(coolKey, Date.now());

    logActivity(`[AntiBot] Exécution procédure d'expulsion pour ${resolved.tag} dans ${jid}`, 'warn');

    // Vérifier si le bot est admin
    const botParticipant = currentGroupData?.participants?.find((p) => {
      const pNum = (p.id || p.jid || '').split('@')[0].split(':')[0];
      return pNum === botNumber;
    });
    const botIsAdmin = botParticipant && (botParticipant.admin === 'admin' || botParticipant.admin === 'superadmin');

    if (!botIsAdmin) {
      logActivity(`[AntiBot] Le bot n'est pas admin dans ${jid}, impossible de kick/fermer le groupe.`, 'warn');
      await sock.sendMessage(jid, {
        text: `⚠️ *تـنـبـيـه نـظـام الـدفـاع (Anti-Bot)* :\nتـم رصـد حـسـاب مـرتـبـط بـبـوت/ويـب ${resolved.tag} ولـكـن تـعـذر طـرده لأن *الـبـوت لـيـس مـشـرفـاً (Admin)* فـي الـمـجـمـوعـة! 👑\nيـرجـى تـرقـيـة الـبـوت لـتـفـعـيـل الـطـرد الـتـلـقـائـي.`,
        mentions: resolved.mentions
      });
      return;
    }

    // 1. Fermer le groupe d'urgence
    try {
      await sock.groupSettingUpdate(jid, 'announcement');
      logActivity(`[AntiBot] Groupe fermé pour neutralisation.`);
    } catch (err) {
      logActivity(`[AntiBot] Échec fermeture groupe: ${err.message}`, 'warn');
    }

    // 2. Tag l'utilisateur et dire (وينو عندو بوت)
    await sock.sendMessage(jid, {
      text: `(وينو عندو بوت) ${resolved.tag}`,
      mentions: resolved.mentions
    });

    // 3. Envoyer l'audio TomLaugh1.opus (PTT)
    const laugh1Opus = path.join(__dirname, 'Media', 'TomLaugh1.opus');
    const laugh1Mpeg = path.join(__dirname, 'Media', 'TomLaugh1.mpeg');
    if (fs.existsSync(laugh1Opus)) {
      try {
        await sock.sendMessage(jid, {
          audio: fs.readFileSync(laugh1Opus),
          mimetype: 'audio/ogg; codecs=opus',
          ptt: true
        });
      } catch (aErr) {
        logActivity(`Échec audio TomLaugh1 opus: ${aErr.message}`, 'warn');
      }
    } else if (fs.existsSync(laugh1Mpeg)) {
      try {
        await sock.sendMessage(jid, {
          audio: fs.readFileSync(laugh1Mpeg),
          mimetype: 'audio/mp4',
          ptt: false
        });
      } catch (aErr) {
        logActivity(`Échec audio TomLaugh1 mpeg: ${aErr.message}`, 'warn');
      }
    }

    // 4. Kick l'utilisateur
    try {
      await sock.groupParticipantsUpdate(jid, [resolved.participant?.id || targetJid], 'remove');
      logActivity(`[AntiBot] Utilisateur ${resolved.tag} expulsé.`);
    } catch (kickErr) {
      logActivity(`[AntiBot] Erreur expulsion ${resolved.tag}: ${kickErr.message}`, 'warn');
    }

    // 5. Récupérer et taguer les admins pour les informer
    const adminParticipants = currentGroupData?.participants?.filter((adm) => {
      if (adm.admin !== 'admin' && adm.admin !== 'superadmin') return false;
      const admNum = (adm.id || adm.jid || '').split('@')[0].split(':')[0];
      return admNum !== resolved.phone && admNum !== botNumber;
    }) || [];

    const adminMentions = [];
    const adminTags = [];
    for (const adm of adminParticipants) {
      const rawJid = adm.id || adm.jid;
      if (rawJid) {
        adminMentions.push(rawJid);
        const admNum = (adm.jid || adm.id).split('@')[0].split(':')[0];
        adminTags.push(`@${admNum}`);
      }
    }

    let alertText = `⎔⋅• ━ ╼━ ╼╃ ⌬〔 🤖 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
    alertText += `       🏰 *إمـبـراطـوريـة بـاراديـس* 🏰\n`;
    alertText += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 🚨 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n\n`;
    alertText += `🤖 *رادار الـدفـاع: طـرد حـسـاب مـرتـبـط بـبـوت / ويـب!* 🤖\n\n`;
    alertText += `تـم رصـد حـسـاب مـرتـبـط بـأجـهـزة خـارجـيـة / واتـسـاب ويـب / بـوت!\n\n`;
    alertText += `⋄ الـعـضـو : ${resolved.tag}\n`;
    alertText += `⋄ الإجـراء : تـم الـطـرد الـفـوري مـن الـمـجـمـوعـة 👢\n\n`;
    if (adminTags.length > 0) {
      alertText += `👑 *إشـعـار لـلإدارة والـمـشـرفـيـن* :\n${adminTags.join(' ')}\n\n`;
    }
    alertText += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚔️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
    alertText += `       🏰 *PARADIS EMPIRE DEFENSE* 🏰`;

    await sock.sendMessage(jid, {
      text: alertText,
      mentions: [...adminMentions, ...resolved.mentions]
    });

    // 6. Rouvrir le groupe après 2 secondes
    await sleep(2000);
    try {
      await sock.groupSettingUpdate(jid, 'not_announcement');
      logActivity(`[AntiBot] Groupe rouvert.`);
    } catch (openErr) {
      logActivity(`Échec réouverture groupe: ${openErr.message}`, 'warn');
    }
  } catch (err) {
    console.error('Erreur executeAntiBotProcedure:', err);
    try {
      await sock.groupSettingUpdate(jid, 'not_announcement');
    } catch (_) {}
  }
}

/**
 * Module de Détection et Défense Anti-Bot lors de l'entrée dans le groupe
 */
async function handleAntiBotParticipantCheck(botPhone, sock, update) {
  try {
    const { id: jid, participants, action } = update;
    if (!jid || action !== 'add' || !participants || participants.length === 0) return;

    // Vérifier si l'Anti-Bot est activé dans ce groupe
    if (!isAntiBotEnabled(jid)) return;

    const botNumber = (sock.user?.id || '').split('@')[0].split(':')[0];

    for (const p of participants) {
      const pNum = (p || '').split('@')[0].split(':')[0];
      if (!pNum || pNum === botNumber) continue;
      if (isSudo(p)) continue;

      const check = await checkUserHasLinkedDevices(sock, p);
      if (check.hasLinked) {
        logActivity(`[AntiBot] Nouvel arrivant @${pNum} lié à ${check.count} appareil(s) -> Expulsion!`, 'warn');
        await executeAntiBotProcedure(sock, jid, p, null);
      }
    }
  } catch (err) {
    console.error('Erreur handleAntiBotParticipantCheck:', err);
  }
}

async function handleWarnCommand(sock, jid, messageText, groupData, msg) {
  try {
    const targetUserId = extractTargetUser(messageText, msg);
    if (!targetUserId) {
      await sock.sendMessage(jid, { text: '❌ *صيغة غير صحيحة*. مثال: .warn @عضو أو رد على رسالته بـ .warn' });
      return;
    }

    const resolved = await resolveGroupParticipant(sock, jid, targetUserId, groupData);
    if (!resolved.participant) {
      await sock.sendMessage(jid, { text: '❌ هذا العضو غير موجود في المجموعة.' });
      return;
    }

    const newWarningCount = addWarning(jid, resolved.phone, resolved.mentions);

    let responseText = `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚠️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
    responseText += `       🏰 *إمـبـراطـوريـة بـاراديـس* 🏰\n`;
    responseText += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚠️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n\n`;
    responseText += `⚠️ *تـم إضـافـة إنـذار إداري* :\n`;
    responseText += `⋄ الـعـضـو : ${resolved.tag}\n`;
    responseText += `⋄ رصـيـد الإنـذارات : *${newWarningCount} / ${CONFIG.maxWarnings}*\n\n`;

    if (newWarningCount >= CONFIG.maxWarnings) {
      const jidToRemove = resolved.participant.id || resolved.participant.jid || targetUserId;
      try {
        await sock.groupParticipantsUpdate(jid, [jidToRemove], 'remove');
      } catch (rmErr) {
        logActivity(`Échec expulsion warn: ${rmErr.message}`, 'warn');
      }
      resetWarnings(jid, resolved.phone, resolved.mentions);
      responseText += `❌ *تـم طـرد ${resolved.tag} مـن الـمـجـمـوعـة لـتـجـاوز الـحـد الأقـصـى لـلإنـذارات.* 👢\n\n`;
    }

    responseText += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚔️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
    responseText += `       🏰 *PARADIS EMPIRE* 🏰`;

    await sock.sendMessage(jid, { text: responseText, mentions: resolved.mentions });
    logActivity(`!warn appliqué pour ${resolved.phone} (${newWarningCount}/${CONFIG.maxWarnings})`);
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
    helpText += `│ ⋄ *.rulls* ⇠ قـوانـيـن الـمـجـمـوعـة 📜\n`;
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
      helpText += `│ ⋄ *.scan* ⇠ فـحـص كـافـة الأعـضـاء لـكـشـف الأجـهـزة والـبـوتـات 🔍\n` +
`│ ⋄ *.antibot [on/off]* ⇠ تـفـعـيـل أو تـعـطـيـل طـرد الـبـوتـات تـلـقـائـيـاً 🤖\n` +
`│ ⋄ *.antilink [on/off]* ⇠ تـفـعـيـل أو تـعـطـيـل مـضـاد الـروابـط 🛡️\n`;
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
    helpText += `│ ⋄ 🤖 *مـضـاد الـبـوتـات* : كـشـف الأجـهـزة الـمـرتـبـطـة + قـفـل الـمـجـمـوعـة + طـرد + صـوتـيـة\n`;
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
    let rulesText = `⚠️ قــوانــيــن الـمـجـمـوعـة | الإلــتــزام واجــب ⚠️\n\n\n`;
    rulesText += `🌿🌿🚫 مـمـنـوع الـسـبـام والإزعـاج\n\n`;
    rulesText += `🌿🚫 مـمـنـوع الـصـور أو الـمـلـصـقـات الـمـخـلـة\n\n`;
    rulesText += `🌿🚫 مـمـنـوع فـتـح الـمـكـالـمـات الـصـوتـيـة\n\n`;
    rulesText += `🌿🚫 مـمـنـوع الـسـب والـشـتـم\n\n`;
    rulesText += `🌿🚫 مـمـنـوع الـتـرويـج والـروابـط\n\n`;
    rulesText += `🌿🚫 مـمـنـوع الـتـحـرش أو الـمـواضـيـع الـجـنـسـيـة\n\n`;
    rulesText += `🌿🚫 مـمـنـوع الـتـنـمـر أو الـتـقـلـيـل مـن الأعـضـاء\n\n`;
    rulesText += `🌿🚫 مـمـنـوع إفـتـعـال الـمـشـاكـل أو الـتـهـديـد\n\n`;
    rulesText += `🌿✨ إحترامك دليل على رقيك ✨🌿`;

    await sock.sendMessage(jid, { text: rulesText });
  } catch (err) {
    console.error('Erreur !rulls:', err);
  }
}

/**
 * Résoudre un participant dans le groupe pour obtenir son vrai numéro de téléphone et ses mentions valides
 * (Convertit les identifiants LID obscurs en numéros de téléphone réels pour un tag cliquable)
 */
async function resolveGroupParticipant(sock, jid, targetId, groupData = null) {
  let gData = groupData;
  if (!gData || !gData.participants || gData.participants.length === 0) {
    try {
      gData = await sock.groupMetadata(jid);
    } catch (_) {}
  }

  const cleanTarget = String(targetId || '').split('@')[0].split(':')[0];
  const allMentions = new Set();
  if (targetId) allMentions.add(targetId);

  let phone = cleanTarget;
  let matchedParticipant = null;

  if (gData?.participants) {
    matchedParticipant = gData.participants.find((p) => {
      const pId = (p.id || '').split('@')[0].split(':')[0];
      const pJid = (p.jid || '').split('@')[0].split(':')[0];
      const pLid = (p.lid || '').split('@')[0].split(':')[0];
      return pId === cleanTarget || pJid === cleanTarget || pLid === cleanTarget;
    });

    if (matchedParticipant) {
      if (matchedParticipant.id) allMentions.add(matchedParticipant.id);
      if (matchedParticipant.jid) allMentions.add(matchedParticipant.jid);
      if (matchedParticipant.lid) allMentions.add(matchedParticipant.lid);

      // Prioriser le vrai numéro de téléphone (@s.whatsapp.net)
      if (matchedParticipant.jid && matchedParticipant.jid.endsWith('@s.whatsapp.net')) {
        phone = matchedParticipant.jid.split('@')[0].split(':')[0];
        allMentions.add(`${phone}@s.whatsapp.net`);
      } else if (matchedParticipant.id && matchedParticipant.id.endsWith('@s.whatsapp.net')) {
        phone = matchedParticipant.id.split('@')[0].split(':')[0];
        allMentions.add(`${phone}@s.whatsapp.net`);
      } else if (matchedParticipant.phoneNumber) {
        phone = String(matchedParticipant.phoneNumber).split('@')[0].split(':')[0];
        allMentions.add(`${phone}@s.whatsapp.net`);
      }
    }
  }

  if (phone) {
    allMentions.add(`${phone}@s.whatsapp.net`);
  }

  return {
    phone,
    tag: `@${phone}`,
    mentions: Array.from(allMentions).filter(Boolean),
    participant: matchedParticipant
  };
}

async function handleCheckWarningsCommand(sock, jid, messageText, senderId, msg, groupData = null) {
  try {
    let targetUserId = extractTargetUser(messageText, msg) || senderId;

    const resolved = await resolveGroupParticipant(sock, jid, targetUserId, groupData);
    const count = getWarningCount(jid, resolved.phone, resolved.mentions);

    let text = `⎔⋅• ━ ╼━ ╼╃ ⌬〔 📋 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
    text += `       🏰 *إمـبـراطـوريـة بـاراديـس* 🏰\n`;
    text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 📋 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n\n`;
    text += `📋 *سـجـل الإنـذارات الـرسـمـي* :\n`;
    text += `⋄ الـعـضـو : ${resolved.tag}\n`;
    text += `⋄ رصـيـد الإنـذارات : *${count} / ${CONFIG.maxWarnings}*\n\n`;

    if (count === 0) {
      text += `✨ *سـجـل نـظـيـف، لا تـوجـد أي مـخـالـفـات!* ✨\n`;
    } else {
      text += `⚠️ *تـحـذيـر: عـنـد الـوصـول إلـى ${CONFIG.maxWarnings} إنـذارات، يـتـم الـطـرد تـلـقـائـيـاً.* ⚠️\n`;
    }

    text += `\n⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚔️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
    text += `       🏰 *PARADIS EMPIRE* 🏰`;

    await sock.sendMessage(jid, { text: text, mentions: resolved.mentions });
  } catch (err) {
    console.error('Erreur !warnings:', err);
  }
}

async function handleResetWarnCommand(sock, jid, messageText, groupData = null, msg = null) {
  try {
    const targetUserId = extractTargetUser(messageText, msg);
    if (!targetUserId) {
      await sock.sendMessage(jid, { text: '❌ *صيغة غير صحيحة*. مثال: *.resetwarn @عضو* أو رد على رسالته بـ *.resetwarn*' });
      return;
    }

    const resolved = await resolveGroupParticipant(sock, jid, targetUserId, groupData);
    resetWarnings(jid, resolved.phone, resolved.mentions);

    let text = `⎔⋅• ━ ╼━ ╼╃ ⌬〔 🔄 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
    text += `       🏰 *إمـبـراطـوريـة بـاراديـس* 🏰\n`;
    text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 🔄 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n\n`;
    text += `✅ *تـم تـصـفـيـر الإنـذارات بـنـجـاح* :\n`;
    text += `⋄ الـعـضـو : ${resolved.tag}\n`;
    text += `⋄ رصـيـد الإنـذارات الـحـالـي : *0 / ${CONFIG.maxWarnings}*\n\n`;
    text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚔️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
    text += `       🏰 *PARADIS EMPIRE* 🏰`;

    await sock.sendMessage(jid, { 
      text: text,
      mentions: resolved.mentions
    });
  } catch (err) {
    console.error('Erreur !resetwarn:', err);
  }
}

async function handleManualKickCommand(sock, jid, messageText, groupData, msg) {
  try {
    const targetUserId = extractTargetUser(messageText, msg);
    if (!targetUserId) {
      await sock.sendMessage(jid, { text: '❌ *صيغة غير صحيحة*. مثال: *.kick @عضو* أو رد على رسالته بـ *.kick*' });
      return;
    }

    let currentGroupData = groupData;
    if (!currentGroupData || !currentGroupData.participants) {
      try {
        currentGroupData = await sock.groupMetadata(jid);
      } catch (_) {}
    }

    const resolved = await resolveGroupParticipant(sock, jid, targetUserId, currentGroupData);
    const jidToRemove = resolved.participant?.id || resolved.participant?.jid || targetUserId;

    // Protection créateur / fondateur du groupe
    const ownerJid = currentGroupData?.owner || currentGroupData?.subjectOwner || '';
    const ownerNumber = ownerJid ? ownerJid.split('@')[0].split(':')[0] : null;

    const isCreator = (
      (ownerNumber && resolved.phone === ownerNumber) ||
      (resolved.participant && (resolved.participant.admin === 'superadmin' || resolved.participant.isSuperAdmin)) ||
      (ownerJid && (resolved.participant?.id === ownerJid || resolved.participant?.jid === ownerJid))
    );

    if (isCreator) {
      await sock.sendMessage(jid, {
        text: `هههه ولد العبد باغي اطرد المؤسس قاري فالزحام`,
        mentions: resolved.mentions
      }, { quoted: msg });

      const laughOpus = path.join(__dirname, 'Media', 'TomLaugh.opus');
      const laughMpeg = path.join(__dirname, 'Media', 'TomLaugh.mpeg');
      if (fs.existsSync(laughOpus)) {
        try {
          await sock.sendMessage(jid, {
            audio: fs.readFileSync(laughOpus),
            mimetype: 'audio/ogg; codecs=opus',
            ptt: true
          });
        } catch (aErr) {
          logActivity(`Échec envoi audio TomLaugh opus: ${aErr.message}`, 'warn');
        }
      } else if (fs.existsSync(laughMpeg)) {
        try {
          await sock.sendMessage(jid, {
            audio: fs.readFileSync(laughMpeg),
            mimetype: 'audio/mp4',
            ptt: false
          });
        } catch (aErr) {
          logActivity(`Échec envoi audio TomLaugh mpeg: ${aErr.message}`, 'warn');
        }
      }
      return;
    }

    // Protection compte bot
    const botNumber = (sock.user?.id || '').split('@')[0].split(':')[0];
    if (resolved.phone === botNumber) {
      await sock.sendMessage(jid, { text: '❌ لا يـمـكـنـك طـرد الـبـوت مـن الـمـجـمـوعـة 🤖' });
      return;
    }

    let text = `⎔⋅• ━ ╼━ ╼╃ ⌬〔 👢 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
    text += `       🏰 *إمـبـراطـوريـة بـاراديـس* 🏰\n`;
    text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 👢 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n\n`;
    text += `👢 *تـم طـرد الـعـضـو* : ${resolved.tag}\n`;
    text += `بـواسـطـة الإدارة.\n\n`;
    text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚔️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
    text += `       🏰 *PARADIS EMPIRE* 🏰`;

    await sock.sendMessage(jid, { text, mentions: resolved.mentions });
    await sock.groupParticipantsUpdate(jid, [jidToRemove], 'remove');
    resetWarnings(jid, resolved.phone, resolved.mentions);
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

    const resolved = await resolveGroupParticipant(sock, jid, targetUserId, currentGroupData);
    const participant = resolved.participant;

    if (!participant) {
      await sock.sendMessage(jid, { text: '❌ الـعـضـو غـيـر مـوجـود فـي هـذه الـمـجـمـوعـة.' });
      return;
    }

    if (participant.admin === 'admin' || participant.admin === 'superadmin') {
      await sock.sendMessage(jid, { 
        text: `ℹ️ الـعـضـو ${resolved.tag} مـشـرف بـالـفـعـل فـي الـمـجـمـوعـة 👑`,
        mentions: resolved.mentions
      });
      return;
    }

    const jidToPromote = participant.id || participant.jid || `${resolved.phone}@s.whatsapp.net`;
    await sock.groupParticipantsUpdate(jid, [jidToPromote], 'promote');

    let text = `⎔⋅• ━ ╼━ ╼╃ ⌬〔 🎖️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
    text += `       🏰 *إمـبـراطـوريـة بـاراديـس* 🏰\n`;
    text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 🎖️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n\n`;
    text += `👑 *تـمـت الـتـرقـيـة إلـى مـشـرف بـنـجـاح* 👑\n\n`;
    text += `⋄ الـعـضـو : ${resolved.tag}\n`;
    text += `⋄ الـرتـبـة : مـشـرف الـمـجـمـوعـة (Group Admin)\n\n`;
    text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚔️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
    text += `       🏰 *PARADIS EMPIRE* 🏰`;

    await sock.sendMessage(jid, {
      text,
      mentions: resolved.mentions
    });
    logActivity(`[Promote] ${resolved.tag} promu admin dans ${jid}`);

    // Message supplémentaire demandé : (ها كيفاش كيحس)
    await sock.sendMessage(jid, {
      text: `(ها كيفاش كيحس)`
    });

    // Audio OMGWAW
    const opusPath = path.join(__dirname, 'Media', 'OMGWAW.opus');
    const mpegPath = path.join(__dirname, 'Media', 'OMGWAW.mpeg');

    if (fs.existsSync(opusPath)) {
      try {
        await sock.sendMessage(jid, {
          audio: fs.readFileSync(opusPath),
          mimetype: 'audio/ogg; codecs=opus',
          ptt: true
        });
      } catch (audioErr) {
        logActivity(`Échec envoi audio promote opus: ${audioErr.message}`, 'warn');
      }
    } else if (fs.existsSync(mpegPath)) {
      try {
        await sock.sendMessage(jid, {
          audio: fs.readFileSync(mpegPath),
          mimetype: 'audio/mp4',
          ptt: false
        });
      } catch (audioErr) {
        logActivity(`Échec envoi audio promote mpeg: ${audioErr.message}`, 'warn');
      }
    }
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

    const resolved = await resolveGroupParticipant(sock, jid, targetUserId, currentGroupData);
    const participant = resolved.participant;

    if (!participant) {
      await sock.sendMessage(jid, { text: '❌ الـعـضـو غـيـر مـوجـود فـي هـذه الـمـجـمـوعـة.' });
      return;
    }

    // Protection propriétaire du groupe
    const ownerNumber = currentGroupData.owner ? currentGroupData.owner.split('@')[0].split(':')[0] : null;
    if (ownerNumber && resolved.phone === ownerNumber) {
      await sock.sendMessage(jid, { text: '❌ لا يـمـكـن تـنـزيـل مـالـك / مـنـشـئ الـمـجـمـوعـة 🛡️' });
      return;
    }

    if (participant.admin !== 'admin' && participant.admin !== 'superadmin') {
      await sock.sendMessage(jid, { 
        text: `ℹ️ الـعـضـو ${resolved.tag} لـيـس مـشـرفـاً بـالأسـاس.`,
        mentions: resolved.mentions
      });
      return;
    }

    const jidToDemote = participant.id || participant.jid || `${resolved.phone}@s.whatsapp.net`;
    await sock.groupParticipantsUpdate(jid, [jidToDemote], 'demote');

    let text = `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⬇️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
    text += `       🏰 *إمـبـراطـوريـة بـاراديـس* 🏰\n`;
    text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⬇️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n\n`;
    text += `📉 *تـم تـنـزيـل الـرتـبـة إلـى عـضـو* 📉\n\n`;
    text += `⋄ الـعـضـو : ${resolved.tag}\n`;
    text += `⋄ تـم تـجـريـده مـن صـلاحـيـات الإشـراف بـنـجـاح.\n\n`;
    text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚔️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
    text += `       🏰 *PARADIS EMPIRE* 🏰`;

    await sock.sendMessage(jid, {
      text,
      mentions: resolved.mentions
    });
    logActivity(`[Demote] ${resolved.tag} rétrogradé membre dans ${jid}`);

    // Message supplémentaire demandé : (خخخ شو كيبكي)
    await sock.sendMessage(jid, {
      text: `(خخخ شو كيبكي)`
    });

    // Audio CRY
    const opusPath = path.join(__dirname, 'Media', 'CRY.opus');
    const mpegPath = path.join(__dirname, 'Media', 'CRY.mpeg');

    if (fs.existsSync(opusPath)) {
      try {
        await sock.sendMessage(jid, {
          audio: fs.readFileSync(opusPath),
          mimetype: 'audio/ogg; codecs=opus',
          ptt: true
        });
      } catch (audioErr) {
        logActivity(`Échec envoi audio demote opus: ${audioErr.message}`, 'warn');
      }
    } else if (fs.existsSync(mpegPath)) {
      try {
        await sock.sendMessage(jid, {
          audio: fs.readFileSync(mpegPath),
          mimetype: 'audio/mp4',
          ptt: false
        });
      } catch (audioErr) {
        logActivity(`Échec envoi audio demote mpeg: ${audioErr.message}`, 'warn');
      }
    }
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
 * Commande .antibot on / .antibot off (Group Admins / Sudo)
 */
async function handleAntiBotToggleCommand(sock, jid, messageText, senderIsAdmin, senderIsSudo) {
  try {
    if (!senderIsAdmin && !senderIsSudo) {
      await sock.sendMessage(jid, { text: '⚠️ *عـذراً!* هذا الأمر مخصص لمشرفي المجموعة أو مطوري البوت فقط.' });
      return;
    }

    const words = messageText.trim().split(/\s+/);
    const arg = (words[1] || '').toLowerCase();

    if (arg === 'on' || arg === 'تشغيل' || arg === 'تفعيل') {
      setAntiBotEnabled(jid, true);
      let text = `⎔⋅• ━ ╼━ ╼╃ ⌬〔 🤖 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
      text += `       🏰 *إمـبـراطـوريـة بـاراديـس* 🏰\n`;
      text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 🤖 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n\n`;
      text += `🤖 *تـم تـفـعـيـل مـضـاد الـبـوتـات (Anti-Bot ON)*\n\n`;
      text += `⋄ سـيـتـم فـحـص أي عـضـو جـديـد يـنـضـم لـلـمـجـمـوعـة.\n`;
      text += `⋄ إذا تـبـيـن أنـه مـرتـبـط بـجـهـاز خـارجـي أو بـوت، سـيـتـم قـفـل الـمـجـمـوعـة وطـرده فـوراً 🚫.\n\n`;
      text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚔️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
      text += `       🏰 *PARADIS EMPIRE* 🏰`;
      await sock.sendMessage(jid, { text });
      logActivity(`[AntiBot] Activé dans ${jid}`);
      return;
    }

    if (arg === 'off' || arg === 'تعطيل' || arg === 'ايقاف') {
      setAntiBotEnabled(jid, false);
      let text = `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚠️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
      text += `       🏰 *إمـبـراطـوريـة بـاراديـس* 🏰\n`;
      text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚠️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n\n`;
      text += `⚠️ *تـم إيـقـاف مـضـاد الـبـوتـات (Anti-Bot OFF)*\n\n`;
      text += `⋄ تـم تـعـطـيـل الـطـرد الـتـلـقـائـي لـلـحـسـابـات والـبـوتـات الـمـرتـبـطـة.\n\n`;
      text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚔️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
      text += `       🏰 *PARADIS EMPIRE* 🏰`;
      await sock.sendMessage(jid, { text });
      logActivity(`[AntiBot] Désactivé dans ${jid}`);
      return;
    }

    // Afficher statut actuel
    const currentStatus = isAntiBotEnabled(jid);
    let text = `⎔⋅• ━ ╼━ ╼╃ ⌬〔 🤖 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
    text += `       🏰 *إمـبـراطـوريـة بـاراديـس* 🏰\n`;
    text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 🤖 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n\n`;
    text += `🤖 *حـالـة مـضـاد الـبـوتـات* : ${currentStatus ? '🟢 مـفـعـل (ON)' : '🔴 مـعـطـل (OFF)'}\n\n`;
    text += `⋄ لـلـتـفـعـيـل : *.antibot on*\n`;
    text += `⋄ لـلـتـعـطـيـل : *.antibot off*\n\n`;
    text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚔️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
    text += `       🏰 *PARADIS EMPIRE* 🏰`;
    await sock.sendMessage(jid, { text });
  } catch (err) {
    console.error('Erreur handleAntiBotToggleCommand:', err);
  }
}

/**
 * Commande .scan (Group Admins / Sudo)
 * Scanne tous les membres du groupe pour détecter ceux qui ont lié leur WhatsApp à un appareil/bot
 */
async function handleScanCommand(sock, jid, groupData, senderIsAdmin, senderIsSudo) {
  try {
    if (!senderIsAdmin && !senderIsSudo) {
      await sock.sendMessage(jid, { 
        text: '⚠️ *عـذراً!* أمـر الـفـحـص مـخـصـص لـمـشـرفـي الـمـجـمـوعـة أو الـمـطـوريـن فـقـط 🛡️' 
      });
      return;
    }

    let currentGroupData = groupData;
    if (!currentGroupData || !currentGroupData.participants) {
      try {
        currentGroupData = await sock.groupMetadata(jid);
      } catch (_) {}
    }

    const participants = currentGroupData?.participants || [];
    if (participants.length === 0) {
      await sock.sendMessage(jid, { text: '❌ تـعـذر جـلـب بـيـانـات أعـضـاء الـمـجـمـوعـة.' });
      return;
    }

    await sock.sendMessage(jid, {
      text: `🔍 *جـاري فـحـص أعـضـاء الـمـجـمـوعـة (${participants.length} عـضـو) لـكـشـف الأجـهـزة الـمـرتـبـطـة والـبـوتـات...*`
    });

    const botNumber = (sock.user?.id || '').split('@')[0].split(':')[0];
    const detected = [];

    // Diviser les participants en lots de 25
    const jidList = participants.map((p) => p.id || p.jid).filter(Boolean);
    const chunkSize = 25;

    for (let i = 0; i < jidList.length; i += chunkSize) {
      const batch = jidList.slice(i, i + chunkSize);
      try {
        if (typeof sock.getUSyncDevices === 'function') {
          const devices = await sock.getUSyncDevices(batch, false, false);
          if (Array.isArray(devices)) {
            for (const dev of devices) {
              const devId = Number(dev.device);
              if (!isNaN(devId) && devId > 0) {
                const userPhone = dev.user;
                if (userPhone === botNumber) continue;

                let entry = detected.find((d) => d.phone === userPhone);
                if (!entry) {
                  const pObj = participants.find((p) => (p.id || p.jid || '').includes(userPhone));
                  const targetRawJid = pObj?.id || pObj?.jid || `${userPhone}@s.whatsapp.net`;
                  const resolved = await resolveGroupParticipant(sock, jid, userPhone, currentGroupData);
                  entry = {
                    phone: userPhone,
                    rawJid: targetRawJid,
                    tag: resolved.tag,
                    mentions: resolved.mentions,
                    deviceCount: 0,
                    isAdmin: pObj && (pObj.admin === 'admin' || pObj.admin === 'superadmin')
                  };
                  detected.push(entry);
                }
                entry.deviceCount += 1;
              }
            }
          }
        }
      } catch (batchErr) {
        logActivity(`[Scan] Erreur USync batch: ${batchErr.message}`, 'warn');
      }
    }

    const antibotActive = isAntiBotEnabled(jid);
    let text = `⎔⋅• ━ ╼━ ╼╃ ⌬〔 🔍 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
    text += `       🏰 *إمـبـراطـوريـة بـاراديـس* 🏰\n`;
    text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 🔍 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n\n`;
    text += `📊 *تـقـريـر فـحـص الأجـهـزة الـمـرتـبـطـة والـبـوتـات (Scan)* 📊\n\n`;
    text += `⋄ إجـمـالـي الأعـضـاء الـمـفـحـوصـيـن : *${participants.length}*\n`;
    text += `⋄ الـحـسـابـات الـمـرتـبـطـة بـأجـهـزة / بـوت : *${detected.length}*\n`;
    text += `⋄ حـالـة مـضـاد الـبـوتـات : *${antibotActive ? '🟢 مـفـعـل (طـرد تـلـقـائـي)' : '🔴 مـعـطـل'}*\n\n`;

    const allMentions = [];
    const membersToKick = [];

    if (detected.length === 0) {
      text += `✅ *الـمـجـمـوعـة نـظـيـفـة تـمـامـاً* 🛡️\n`;
      text += `لا يـوجـد أي حـسـاب مـرتـبـط بـجـهـاز خـارجـي (Web/Desktop/Bot).\n\n`;
    } else {
      text += `⚠️ *قـائـمـة الـحـسـابـات الـمـرتـبـطـة* :\n`;
      detected.forEach((item, idx) => {
        let statusBadge = '';
        if (item.isAdmin) {
          statusBadge = '👑 مشرف (مستثنى)';
        } else if (antibotActive) {
          statusBadge = '👤 عضو ↬ 👢 *جـاري الـطـرد*';
          membersToKick.push(item);
        } else {
          statusBadge = '👤 عضو';
        }

        text += `${idx + 1}️⃣ ${item.tag} (${statusBadge}) ↬ *${item.deviceCount} جهاز مرتبط* 🤖\n`;
        allMentions.push(...item.mentions);
      });
      text += `\n💡 *مـلاحـظـة* : تـشـمـل هـذه الـقـائـمـة الـبـوتـات وأيـضـاً مـسـتـخـدمـي واتـسـاب ويـب / كـمـبـيـوتـر.\n\n`;
    }

    text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚔️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
    text += `       🏰 *PARADIS EMPIRE SCANNER* 🏰`;

    await sock.sendMessage(jid, {
      text,
      mentions: Array.from(new Set(allMentions))
    });

    // Exécuter la procédure d'expulsion pour tous les membres détectés si Anti-Bot est activé
    if (membersToKick.length > 0) {
      for (const target of membersToKick) {
        await executeAntiBotProcedure(sock, jid, target.rawJid, currentGroupData);
      }
    }

  } catch (err) {
    console.error('Erreur handleScanCommand:', err);
    await sock.sendMessage(jid, { text: `❌ حـدث خـطـأ أثـنـاء الـفـحـص : ${err.message}` });
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
 * API: Démarrer une session de jumelage par QR Code
 */
app.post('/api/qr', async (req, res) => {
  try {
    if (activeQrSessionId) {
      const prevSession = sessions.get(activeQrSessionId);
      if (prevSession?.sock) {
        try { prevSession.sock.ev.removeAllListeners(); prevSession.sock.ws?.close(); } catch (_) {}
      }
      const prevDir = path.join(SESSIONS_BASE_DIR, activeQrSessionId);
      if (fs.existsSync(prevDir)) {
        try { fs.rmSync(prevDir, { recursive: true, force: true }); } catch (_) {}
      }
      sessions.delete(activeQrSessionId);
      activeQrSessionId = null;
    }

    const tempId = `qr_${Date.now()}`;
    activeQrSessionId = tempId;
    logActivity(`[${tempId}] Demande de connexion par QR Code...`);

    const session = await startSession(tempId, { isNewPairing: true, isQrMode: true });

    const qrPromise = new Promise((resolve, reject) => {
      session.qrResolve = resolve;
      session.qrReject = reject;

      setTimeout(() => {
        if (session.qrReject) {
          reject(new Error('Délai dépassé (35s) pour obtenir le QR Code WhatsApp.'));
          session.qrResolve = null;
          session.qrReject = null;
        }
      }, 35000);
    });

    const qrDataUrl = await qrPromise;

    res.json({
      success: true,
      qr: qrDataUrl,
      sessionId: tempId
    });
  } catch (err) {
    console.error('Erreur génération QR:', err);
    logActivity(`Erreur génération QR: ${err.message}`, 'warn');
    res.status(500).json({ success: false, error: err.message || 'Échec de la génération du QR Code.' });
  }
});

/**
 * API: Statut d'une session QR
 */
app.get('/api/qr/status', (req, res) => {
  const { sessionId } = req.query;
  const targetId = sessionId || activeQrSessionId;
  if (!targetId) {
    return res.status(400).json({ success: false, error: 'Session ID requis' });
  }

  const session = sessions.get(targetId);
  if (session) {
    return res.json({
      success: true,
      status: session.status,
      phone: session.user?.phone || null,
      qr: session.qr || null
    });
  }

  // Vérifier si elle a été migrée avec succès vers un compte connecté
  for (const [phone, sess] of sessions.entries()) {
    if (sess.status === 'connected' && sess.connectedAt) {
      const connTime = new Date(sess.connectedAt).getTime();
      if (Date.now() - connTime < 30000) {
        return res.json({
          success: true,
          status: 'connected',
          phone: sess.user?.phone || `+${phone}`,
          qr: null
        });
      }
    }
  }

  res.json({
    success: true,
    status: 'disconnected',
    phone: null,
    qr: null
  });
});

/**
 * API: Annuler une session QR
 */
app.post('/api/qr/cancel', (req, res) => {
  const { sessionId } = req.body || {};
  const targetId = sessionId || activeQrSessionId;
  if (targetId) {
    const sess = sessions.get(targetId);
    if (sess?.sock) {
      try { sess.sock.ev.removeAllListeners(); sess.sock.ws?.close(); } catch (_) {}
    }
    const sDir = path.join(SESSIONS_BASE_DIR, targetId);
    if (fs.existsSync(sDir)) {
      try { fs.rmSync(sDir, { recursive: true, force: true }); } catch (_) {}
    }
    sessions.delete(targetId);
    if (activeQrSessionId === targetId) activeQrSessionId = null;
    logActivity(`[${targetId}] Session QR annulée.`);
  }
  res.json({ success: true });
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
          if (phone.startsWith('qr_')) {
            try { fs.rmSync(path.join(SESSIONS_BASE_DIR, phone), { recursive: true, force: true }); } catch (_) {}
            continue;
          }
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
