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
import { initializeDatabase, addWarning, getWarningCount, resetWarnings } from './db.js';
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

      const messageText = extractMessage(msg);
      if (!messageText) continue;

      const trimmedText = messageText.trim();
      const lowerText = trimmedText.toLowerCase();

      logActivity(`[+${botPhone}] [${isGroup ? 'Groupe' : 'Privé'} | ${isFromMe ? 'Moi' : senderId.split('@')[0]}]: "${trimmedText}"`);

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

        // 1. Module Anti-Lien
        if (!isFromMe && !senderIsAdmin && containsUrl(messageText)) {
          await handleAntiLink(sock, jid, senderId, msg.key.id, groupData);
        }

        // 2. Module Anti-Contact
        const isContact = msg.message.contactMessage || msg.message.contactsArrayMessage;
        if (!isFromMe && !senderIsAdmin && isContact) {
          await handleAntiContact(sock, jid, senderId, msg.key.id, groupData);
        }
      } else {
        senderIsAdmin = true;
      }

      // 3. Commandes
      const isCmd = (name) => lowerText === `!${name}` || lowerText === `.${name}` || lowerText === `/${name}`;
      const startsWithCmd = (name) => lowerText.startsWith(`!${name}`) || lowerText.startsWith(`.${name}`) || lowerText.startsWith(`/${name}`);

      // Commande .status
      if (isCmd('status') || isCmd('info') || isCmd('bot') || isCmd('حالة')) {
        await handleStatusCommand(sock, jid, groupData, session);
        continue;
      }

      // Commande .mention / .منشن / .tagall
      if (isCmd('mention') || isCmd('منشن') || isCmd('tagall') || isCmd('الكل') ||
          startsWithCmd('mention') || startsWithCmd('منشن') || startsWithCmd('tagall') || startsWithCmd('الكل')) {
        if (!isGroup) {
          await sock.sendMessage(jid, { text: 'ℹ️ هذه العملية تعمل فقط داخل المجموعات.' });
          continue;
        }
        if (!senderIsAdmin) {
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
        await handleHelpCommand(sock, jid, senderIsAdmin, senderId, session);
        continue;
      }

      // Commande .regles
      if (isCmd('regles') || isCmd('rules') || isCmd('قوانين') || isCmd('القوانين')) {
        await handleRulesCommand(sock, jid);
        continue;
      }

      // Commande .warnings
      if (startsWithCmd('warnings') || startsWithCmd('warns') || startsWithCmd('انذارات') || startsWithCmd('انذاراتي')) {
        if (!isGroup) {
          await sock.sendMessage(jid, { text: 'ℹ️ Cette commande fonctionne uniquement dans un groupe.' });
          continue;
        }
        await handleCheckWarningsCommand(sock, jid, messageText, senderId);
        continue;
      }

      // Commande .warn (Admins)
      if ((startsWithCmd('warn ') || startsWithCmd('انذار ')) && senderIsAdmin) {
        if (!isGroup) {
          await sock.sendMessage(jid, { text: 'ℹ️ Cette commande fonctionne uniquement dans un groupe.' });
          continue;
        }
        await handleWarnCommand(sock, jid, messageText, groupData);
        continue;
      }

      // Commande .resetwarn (Admins)
      if ((startsWithCmd('resetwarn') || startsWithCmd('تصفير')) && senderIsAdmin) {
        if (!isGroup) {
          await sock.sendMessage(jid, { text: 'ℹ️ Cette commande fonctionne uniquement dans un groupe.' });
          continue;
        }
        await handleResetWarnCommand(sock, jid, messageText);
        continue;
      }

      // Commande .kick (Admins)
      if ((startsWithCmd('kick') || startsWithCmd('طرد')) && senderIsAdmin) {
        if (!isGroup) {
          await sock.sendMessage(jid, { text: 'ℹ️ Cette commande fonctionne uniquement dans un groupe.' });
          continue;
        }
        await handleManualKickCommand(sock, jid, messageText, groupData);
        continue;
      }
    }
  } catch (error) {
    console.error('Erreur traitement messages:', error);
    logActivity(`Erreur traitement messages: ${error.message}`, 'warn');
  }
}

/**
 * Fonctions de modération
 */
async function handleAntiLink(sock, jid, senderId, messageId, groupData) {
  try {
    await sock.sendMessage(jid, { delete: { remoteJid: jid, fromMe: false, id: messageId } });
    const newWarningCount = addWarning(jid, senderId);

    const senderMention = formatMention(senderId);
    let notificationText = `⚠️ ${senderMention} Lien détecté et supprimé ! Avertissement ${newWarningCount}/${CONFIG.maxWarnings}`;

    if (newWarningCount >= CONFIG.maxWarnings) {
      await sock.groupParticipantsUpdate(jid, [senderId], 'remove');
      resetWarnings(jid, senderId);
      notificationText += `\n\n❌ Utilisateur ${senderMention} exclu du groupe (${CONFIG.maxWarnings} avertissements atteints).`;
    }

    await sock.sendMessage(jid, { text: notificationText });
    logActivity(`Anti-lien: message supprimé, warn #${newWarningCount} pour ${senderId}`);
  } catch (err) {
    console.error('Erreur anti-lien:', err);
  }
}

async function handleAntiContact(sock, jid, senderId, messageId, groupData) {
  try {
    await sock.sendMessage(jid, { delete: { remoteJid: jid, fromMe: false, id: messageId } });
    await sock.groupParticipantsUpdate(jid, [senderId], 'remove');
    resetWarnings(jid, senderId);

    const admins = groupData?.participants?.filter(p => p.admin === 'admin' || p.admin === 'superadmin')?.map(p => p.id) || [];
    const senderMention = formatMention(senderId);
    const adminMentions = admins.map(adminId => formatMention(adminId)).join(' ');

    const notificationText = `${adminMentions}\n🚫 ${senderMention} a partagé un contact et a été exclu du groupe.`;
    await sock.sendMessage(jid, { text: notificationText, mentions: [senderId, ...admins] });

    logActivity(`Anti-contact: ${senderId} exclu pour partage de fiche contact`);
  } catch (err) {
    console.error('Erreur anti-contact:', err);
  }
}

async function handleWarnCommand(sock, jid, messageText, groupData) {
  try {
    const match = messageText.match(/@(\d+)/);
    if (!match) {
      await sock.sendMessage(jid, { text: '❌ Syntaxe incorrecte. Exemple: !warn @numéro' });
      return;
    }

    const targetUserId = match[1] + '@s.whatsapp.net';
    const targetParticipant = groupData?.participants?.find((p) => p.id === targetUserId);
    if (!targetParticipant) {
      await sock.sendMessage(jid, { text: '❌ Utilisateur introuvable dans ce groupe.' });
      return;
    }

    const newWarningCount = addWarning(jid, targetUserId);
    const targetMention = formatMention(targetUserId);
    let responseText = `⚠️ Avertissement ajouté pour ${targetMention}. Total: ${newWarningCount}/${CONFIG.maxWarnings}`;

    if (newWarningCount >= CONFIG.maxWarnings) {
      await sock.groupParticipantsUpdate(jid, [targetUserId], 'remove');
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
    const allMentions = [];

    for (const p of currentGroupData.participants) {
      const cleanJid = normalizeJid(p.id);
      allMentions.push(cleanJid);

      if (p.admin === 'admin' || p.admin === 'superadmin') {
        admins.push(cleanJid);
      } else {
        members.push(cleanJid);
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
      for (const adminJid of admins) {
        mentionText += `│ ⋄ ${formatMention(adminJid)}\n`;
      }
    } else {
      mentionText += `│ ⋄ لا يوجد مشرفين\n`;
    }
    mentionText += `╰─────────────────────⊷\n\n`;

    // 2. Section الأعضاء
    mentionText += `╭───『 👥 الأعـضـاء (${members.length}) 』───⊷\n`;
    if (members.length > 0) {
      for (const memberJid of members) {
        mentionText += `│ ⋄ ${formatMention(memberJid)}\n`;
      }
    } else {
      mentionText += `│ ⋄ لا يوجد أعضاء إضافيين\n`;
    }
    mentionText += `╰─────────────────────⊷\n\n`;

    mentionText += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚔️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
    mentionText += `       🏰 *PARADIS EMPIRE* 🏰`;

    await sock.sendMessage(jid, {
      text: mentionText,
      mentions: allMentions,
    });

    logActivity(`[Mention] Appel général envoyé dans ${jid} (${totalCount} membres mentionnés)`);
  } catch (err) {
    console.error('Erreur handleMentionCommand:', err);
    logActivity(`Erreur mention: ${err.message}`, 'warn');
  }
}

async function handleHelpCommand(sock, jid, isAdminUser, senderId = null, session = null) {
  try {
    const userPhone = session?.user?.phone || (session?.phone ? `+${session.phone}` : '');

    let helpText = `مرحبا بك في البوت الرسمي ل امبراطورية باراديس \n`;
    if (userPhone) {
      helpText += `📱 *رقم البوت المتصل* : ${userPhone}\n`;
    }
    helpText += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 🌿 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n\n`;

    helpText += `╭───『 📜 أوامـر الأعـضـاء 』───⊷\n`;
    helpText += `│ ⋄ *.menu* ⇠ عـرض قـائـمـة الأوامـر\n`;
    helpText += `│ ⋄ *.status* ⇠ مـعـلـومـات الـحـسـاب والـبـوت\n`;
    helpText += `│ ⋄ *.regles* ⇠ قـوانـيـن الإمـبـراطـوريـة\n`;
    helpText += `│ ⋄ *.warnings* ⇠ فـحـص إنـذاراتـك\n`;
    helpText += `╰─────────────────────⊷\n\n`;

    if (isAdminUser) {
      helpText += `╭───『 ⚔️ أوامـر الـمـشـرفـيـن 』───⊷\n`;
      helpText += `│ ⋄ *.mention* ⇠ نـداء ومـنـشـن شـامـل لـكـافـة الأعـضـاء\n`;
      helpText += `│ ⋄ *.warn @عضو* ⇠ إعـطـاء إنـذار (${CONFIG.maxWarnings} = طرد)\n`;
      helpText += `│ ⋄ *.warnings @عضو* ⇠ فـحـص إنـذارات عـضـو\n`;
      helpText += `│ ⋄ *.resetwarn @عضو* ⇠ تـصـفـيـر إنـذارات عـضـو\n`;
      helpText += `│ ⋄ *.kick @عضو* ⇠ طـرد عـضـو مـن الـمـجـمـوعـة\n`;
      helpText += `╰─────────────────────⊷\n\n`;
    }

    helpText += `╭───『 🛡️ أنـظـمـة الـحـمـايـة 』───⊷\n`;
    helpText += `│ ⋄ 🚫 *مـنـع الـروابـط* : حـذف فـوري + إنـذار\n`;
    helpText += `│ ⋄ 📵 *مـنـع جـهـات الاتـصـال* : طـرد فـوري ومـبـاشـر\n`;
    helpText += `╰─────────────────────⊷\n\n`;

    helpText += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚔️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
    helpText += `       🏰 *PARADIS EMPIRE* 🏰`;

    const options = { text: helpText };
    if (senderId) {
      options.mentions = [senderId];
    }

    await sock.sendMessage(jid, options);
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

    let text = `⎔⋅• ━ ╼━ ╼╃ ⌬〔 🌿 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
    text += `       🏰 *حـالـة الـحـسـاب والـبـوت* 🏰\n`;
    text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 🌿 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n\n`;
    text += `📱 *الـواتـسـاب الـمـتـصـل* : ${userPhone}\n`;
    text += `👤 *اسـم الـحـسـاب* : ${userName}\n`;
    text += `⚡ *حـالـة الـخـادم* : 🟢 مـتـصـل ونـشـط 24/7\n`;
    text += `🤖 *إجمالي البوتات المتصلة* : ${totalActive} حساب\n`;
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

async function handleCheckWarningsCommand(sock, jid, messageText, senderId) {
  try {
    const match = messageText.match(/@(\d+)/);
    let targetUserId = senderId;
    if (match) targetUserId = match[1] + '@s.whatsapp.net';

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

async function handleResetWarnCommand(sock, jid, messageText) {
  try {
    const match = messageText.match(/@(\d+)/);
    if (!match) {
      await sock.sendMessage(jid, { text: '❌ Syntaxe incorrecte. Exemple : *!resetwarn @numéro*' });
      return;
    }

    const targetUserId = match[1] + '@s.whatsapp.net';
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

async function handleManualKickCommand(sock, jid, messageText, groupData) {
  try {
    const match = messageText.match(/@(\d+)/);
    if (!match) {
      await sock.sendMessage(jid, { text: '❌ Syntaxe incorrecte. Exemple : *!kick @numéro*' });
      return;
    }

    const targetUserId = match[1] + '@s.whatsapp.net';
    const targetMention = formatMention(targetUserId);

    await sock.sendMessage(jid, { text: `👋 Expulsion de ${targetMention} par un administrateur...`, mentions: [targetUserId] });
    await sock.groupParticipantsUpdate(jid, [targetUserId], 'remove');
    resetWarnings(jid, targetUserId);
  } catch (err) {
    console.error('Erreur !kick:', err);
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
