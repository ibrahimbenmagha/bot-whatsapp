/**
 * Bot de Modération WhatsApp avec Baileys et Interface Web de Liaison par Code
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
const AUTH_DIR = path.join(__dirname, 'auth_info_multi');

// Assurer l'existence du dossier auth_info_multi
if (!fs.existsSync(AUTH_DIR)) {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
}

// Configuration depuis .env ou valeurs par défaut
const CONFIG = {
  port: parseInt(process.env.PORT, 10) || 3000,
  targetGroupName: process.env.TARGET_GROUP_NAME || 'Votre Nom du Groupe',
  maxWarnings: parseInt(process.env.MAX_WARNINGS, 10) || 3,
};

// Logger Pino pour Baileys (silencieux)
const logger = pino({ level: 'silent' });

// Variables d'état globales
let sock = null;
let db = null;
let authState = null;
let saveCredsFunc = null;
let connectionStatus = 'disconnected'; // 'disconnected' | 'connecting' | 'awaiting_code' | 'connected'
let currentPairingCode = null;
let connectionAttempts = 0;
let connectedAt = null;
let lastConnectedPhone = null;
let lastConnectedName = null;
const activityLogs = [];
const sseClients = new Set();

// Pairing flow control - résout quand le socket Baileys est prêt pour requestPairingCode
let pairingReadyResolve = null;
let pairingReadyReject = null;

/**
 * Ajouter un log en mémoire et notifier l'interface web via SSE
 */
function logActivity(message, logType = 'info') {
  const timestamp = new Date().toLocaleTimeString();
  const formattedMsg = `[${timestamp}] ${message}`;
  console.log(formattedMsg);

  activityLogs.push(formattedMsg);
  if (activityLogs.length > 50) {
    activityLogs.shift();
  }

  broadcastSSE({
    type: 'log',
    message,
    logType,
  });
}

/**
 * Notifier tous les clients SSE
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
 * Met à jour le statut global et notifie les clients web
 */
function updateStatus(newStatus) {
  connectionStatus = newStatus;
  broadcastSSE({
    type: 'status',
    status: newStatus,
    code: currentPairingCode,
  });
}

/**
 * Nettoyer le dossier d'authentification pour repartir à zéro
 */
function cleanAuthDir() {
  try {
    if (fs.existsSync(AUTH_DIR)) {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(AUTH_DIR, { recursive: true });
    logActivity('Identifiants et session réinitialisés.');
  } catch (err) {
    console.error('Erreur nettoyage auth_info_multi:', err);
  }
}

/**
 * Initialiser la socket WhatsApp Baileys
 * @param {string|null} pairingPhone - Si fourni, déclenche requestPairingCode dès que le socket est prêt
 */
async function initializeSocket(pairingPhone = null) {
  try {
    // Initialiser la base de données SQLite une seule fois
    if (!db) {
      db = await initializeDatabase();
    }

    // Charger l'état d'authentification multi-fichiers
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    authState = state;
    saveCredsFunc = saveCreds;

    // Fermer l'ancienne socket si elle existe
    if (sock) {
      try {
        sock.ev.removeAllListeners();
        sock.ws?.close();
      } catch (_) {}
    }

    updateStatus('connecting');
    logActivity('Initialisation de la connexion WhatsApp...');

    sock = makeWASocket({
      auth: authState,
      logger: logger,
      printQRInTerminal: false,
      mobile: false,
      browser: Browsers.ubuntu('Chrome'),
      syncFullHistory: false,
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
    });

    // Sauvegarde automatique des crédits
    sock.ev.on('creds.update', saveCredsFunc);

    // Mises à jour de la connexion - avec gestion du pairing intégrée
    sock.ev.on('connection.update', (update) => {
      handleConnectionUpdate(update, pairingPhone);
    });

    // Écoute des nouveaux messages pour la modération
    sock.ev.on('messages.upsert', handleNewMessages);

    // Mises à jour du groupe
    sock.ev.on('groups.update', handleGroupUpdate);

    return sock;
  } catch (error) {
    logActivity(`Erreur initialisation socket: ${error.message}`, 'warn');
    updateStatus('disconnected');
    throw error;
  }
}

/**
 * Gérer les changements de statut de connexion
 * @param {object} update - L'événement de mise à jour de connexion
 * @param {string|null} pairingPhone - Numéro pour lequel on demande un code de liaison
 */
async function handleConnectionUpdate(update, pairingPhone = null) {
  const { connection, lastDisconnect, qr } = update;

  if (connection === 'connecting') {
    if (connectionStatus !== 'awaiting_code') {
      updateStatus('connecting');
    }
    logActivity('Connexion au serveur WhatsApp en cours...');
  }

  // ──────────────────────────────────────────────────────────
  // CLEF DU FIX: Quand Baileys émet un QR, ça veut dire que
  // le handshake Noise est terminé et que le socket est PRÊT
  // pour recevoir des stanzas IQ comme requestPairingCode.
  // On intercepte ce moment exact pour demander le code.
  // ──────────────────────────────────────────────────────────
  if (qr && pairingPhone) {
    logActivity(`Socket prêt (QR reçu) — Génération du code pour +${pairingPhone}...`);
    try {
      const code = await sock.requestPairingCode(pairingPhone);
      if (code && pairingReadyResolve) {
        pairingReadyResolve(code);
        pairingReadyResolve = null;
        pairingReadyReject = null;
      }
    } catch (err) {
      logActivity(`Erreur requestPairingCode: ${err.message}`, 'warn');
      if (pairingReadyReject) {
        pairingReadyReject(err);
        pairingReadyResolve = null;
        pairingReadyReject = null;
      }
    }
  }

  if (connection === 'open') {
    connectionAttempts = 0;
    currentPairingCode = null;
    updateStatus('connected');
    const userPhone = sock?.user?.id ? sock.user.id.split('@')[0].split(':')[0] : 'Inconnu';
    lastConnectedPhone = userPhone;
    lastConnectedName = sock?.user?.name || 'Bot WhatsApp';
    connectedAt = new Date().toISOString();
    logActivity(`✅ Bot connecté avec succès sur le numéro +${userPhone} (${lastConnectedName}) !`, 'system');
  }

  if (connection === 'close') {
    const statusCode = (lastDisconnect?.error instanceof Boom)
      ? lastDisconnect.error.output?.statusCode
      : lastDisconnect?.error?.output?.statusCode;

    const errorMsg = lastDisconnect?.error?.message || lastDisconnect?.error;
    const isLoggedOut = statusCode === DisconnectReason.loggedOut;

    logActivity(`Connexion fermée: code ${statusCode || 'inconnu'} (${errorMsg})`, 'warn');

    if (isLoggedOut) {
      updateStatus('disconnected');
      currentPairingCode = null;
      cleanAuthDir();
      logActivity('Session déconnectée. Veuillez reconnecter le bot via la page web.', 'warn');
    } else if (connectionStatus === 'awaiting_code') {
      // Pendant la phase de pairing, ne PAS reconnecter automatiquement
      logActivity('Connexion fermée pendant la liaison par code. En attente de validation sur le téléphone...', 'warn');
    } else if (authState?.creds?.registered) {
      // Reconnexion automatique uniquement si une session était déjà validée
      connectionAttempts++;
      const delay = Math.min(connectionAttempts * 3000, 15000);
      logActivity(`Reconnexion automatique dans ${delay / 1000}s... (tentative ${connectionAttempts})`);
      setTimeout(() => {
        initializeSocket().catch(() => {});
      }, delay);
    } else {
      updateStatus('disconnected');
      // Si le pairing était en cours et que la promise n'a pas encore été résolue,
      // on la rejette pour ne pas bloquer l'API
      if (pairingReadyReject) {
        pairingReadyReject(new Error('Connection closed before pairing code could be generated'));
        pairingReadyResolve = null;
        pairingReadyReject = null;
      }
    }
  }
}

/**
 * Gérer les messages entrants (Modération Anti-Lien, Anti-Contact, Warns)
 */
async function handleNewMessages(m) {
  if (connectionStatus !== 'connected' || !m.messages) return;

  try {
    for (const msg of m.messages) {
      if (!msg.message) continue;

      const jid = msg.key.remoteJid;
      if (!jid || jid === 'status@broadcast') continue;

      const isGroup = isGroupMessage(jid);
      const isFromMe = Boolean(msg.key.fromMe);

      // Récupérer l'ID de l'expéditeur
      const rawSender = isGroup
        ? (msg.key.participant || msg.participant || (isFromMe ? sock?.user?.id : null))
        : jid;

      if (!rawSender) continue;
      const senderId = normalizeJid(rawSender);

      const messageText = extractMessage(msg);
      if (!messageText) continue;

      const trimmedText = messageText.trim();
      const lowerText = trimmedText.toLowerCase();

      logActivity(`Message reçu [${isGroup ? 'Groupe' : 'Privé'} | ${isFromMe ? 'Moi' : senderId.split('@')[0]}]: "${trimmedText}"`);

      let groupData = null;
      let senderIsAdmin = isFromMe; // Le propriétaire du bot est toujours considéré admin

      if (isGroup) {
        try {
          groupData = await sock.groupMetadata(jid);
          if (!senderIsAdmin) {
            senderIsAdmin = isAdmin(senderId, groupData);
          }
        } catch (err) {
          logActivity(`Avertissement groupMetadata: ${err.message}`, 'warn');
        }

        // 1. Module Anti-Lien (non-admins et pas depuis le compte bot lui-même)
        if (!isFromMe && !senderIsAdmin && containsUrl(messageText)) {
          await handleAntiLink(jid, senderId, msg.key.id, groupData);
        }

        // 2. Module Anti-Contact (non-admins et pas depuis le compte bot lui-même)
        const isContact = msg.message.contactMessage || msg.message.contactsArrayMessage;
        if (!isFromMe && !senderIsAdmin && isContact) {
          await handleAntiContact(jid, senderId, msg.key.id, groupData);
        }
      } else {
        // En privé (DM), pour tester
        senderIsAdmin = true;
      }

      // 3. Commandes du Bot (supporte !, ., et /)
      const isCmd = (name) => lowerText === `!${name}` || lowerText === `.${name}` || lowerText === `/${name}`;
      const startsWithCmd = (name) => lowerText.startsWith(`!${name}`) || lowerText.startsWith(`.${name}`) || lowerText.startsWith(`/${name}`);

      // Commande !status / .status / .info / .bot / .حالة
      if (isCmd('status') || isCmd('info') || isCmd('bot') || isCmd('حالة')) {
        await handleStatusCommand(jid, groupData);
        continue;
      }

      // Commande !help / !aide / .menu / !menu / .اوامر
      if (isCmd('help') || isCmd('aide') || isCmd('menu') || isCmd('اوامر') || isCmd('الاوامر')) {
        await handleHelpCommand(jid, senderIsAdmin, senderId);
        continue;
      }

      // Commande !regles / !rules / .regles / .rules / .قوانين
      if (isCmd('regles') || isCmd('rules') || isCmd('قوانين') || isCmd('القوانين')) {
        await handleRulesCommand(jid);
        continue;
      }

      // Commande !warnings / !warns / .warnings / .warns / .انذارات
      if (startsWithCmd('warnings') || startsWithCmd('warns') || startsWithCmd('انذارات') || startsWithCmd('انذاراتي')) {
        if (!isGroup) {
          await sock.sendMessage(jid, { text: 'ℹ️ Cette commande fonctionne uniquement dans un groupe.' });
          continue;
        }
        await handleCheckWarningsCommand(jid, messageText, senderId, groupData);
        continue;
      }

      // Commande !warn / .warn / .انذار (Admins uniquement)
      if ((startsWithCmd('warn ') || startsWithCmd('انذار ')) && senderIsAdmin) {
        if (!isGroup) {
          await sock.sendMessage(jid, { text: 'ℹ️ Cette commande fonctionne uniquement dans un groupe.' });
          continue;
        }
        await handleWarnCommand(jid, messageText, groupData);
        continue;
      }

      // Commande !resetwarn / .resetwarn / .تصفير (Admins uniquement)
      if ((startsWithCmd('resetwarn') || startsWithCmd('تصفير')) && senderIsAdmin) {
        if (!isGroup) {
          await sock.sendMessage(jid, { text: 'ℹ️ Cette commande fonctionne uniquement dans un groupe.' });
          continue;
        }
        await handleResetWarnCommand(jid, messageText, groupData);
        continue;
      }

      // Commande !kick / .kick / .طرد (Admins uniquement)
      if ((startsWithCmd('kick') || startsWithCmd('طرد')) && senderIsAdmin) {
        if (!isGroup) {
          await sock.sendMessage(jid, { text: 'ℹ️ Cette commande fonctionne uniquement dans un groupe.' });
          continue;
        }
        await handleManualKickCommand(jid, messageText, groupData);
        continue;
      }
    }
  } catch (error) {
    console.error('Erreur traitement messages:', error);
    logActivity(`Erreur traitement messages: ${error.message}`, 'warn');
  }
}

/**
 * Module Anti-Lien
 */
async function handleAntiLink(jid, senderId, messageId, groupData) {
  try {
    await sock.sendMessage(jid, { delete: { remoteJid: jid, fromMe: false, id: messageId } });
    const newWarningCount = addWarning(jid, senderId);

    const senderMention = formatMention(senderId);
    let notificationText = `⚠️ ${senderMention} Lien détecté et supprimé ! Avertissement ${newWarningCount}/${CONFIG.maxWarnings}`;

    if (newWarningCount >= CONFIG.maxWarnings) {
      await handleUserKick(jid, senderId, groupData);
      notificationText += `\n\n❌ Utilisateur ${senderMention} exclu du groupe (${CONFIG.maxWarnings} avertissements atteints).`;
    }

    await sock.sendMessage(jid, { text: notificationText });
    logActivity(`Anti-lien: message supprimé, warn #${newWarningCount} pour ${senderId}`);
  } catch (err) {
    console.error('Erreur anti-lien:', err);
  }
}

/**
 * Module Anti-Contact
 */
async function handleAntiContact(jid, senderId, messageId, groupData) {
  try {
    await sock.sendMessage(jid, { delete: { remoteJid: jid, fromMe: false, id: messageId } });
    await sock.groupParticipantsUpdate(jid, [senderId], 'remove');
    resetWarnings(jid, senderId);

    const admins = groupData.participants.filter(p => p.admin === 'admin' || p.admin === 'superadmin').map(p => p.id);
    const senderMention = formatMention(senderId);
    const adminMentions = admins.map(adminId => formatMention(adminId)).join(' ');

    const notificationText = `${adminMentions}\n🚫 ${senderMention} a partagé un contact et a été exclu du groupe.`;
    await sock.sendMessage(jid, { text: notificationText, mentions: [senderId, ...admins] });

    logActivity(`Anti-contact: ${senderId} exclu pour partage de fiche contact`);
  } catch (err) {
    console.error('Erreur anti-contact:', err);
  }
}

/**
 * Commande manuelle !warn
 */
async function handleWarnCommand(jid, messageText, groupData) {
  try {
    const match = messageText.match(/@(\d+)/);
    if (!match) {
      await sock.sendMessage(jid, { text: '❌ Syntaxe incorrecte. Exemple: !warn @numéro' });
      return;
    }

    const targetUserId = match[1] + '@s.whatsapp.net';
    const targetParticipant = groupData.participants.find((p) => p.id === targetUserId);
    if (!targetParticipant) {
      await sock.sendMessage(jid, { text: '❌ Utilisateur introuvable dans ce groupe.' });
      return;
    }

    const newWarningCount = addWarning(jid, targetUserId);
    const targetMention = formatMention(targetUserId);
    let responseText = `⚠️ Avertissement ajouté pour ${targetMention}. Total: ${newWarningCount}/${CONFIG.maxWarnings}`;

    if (newWarningCount >= CONFIG.maxWarnings) {
      await handleUserKick(jid, targetUserId, groupData);
      responseText += `\n\n❌ ${targetMention} a été exclu (${CONFIG.maxWarnings} avertissements atteints).`;
    }

    await sock.sendMessage(jid, { text: responseText, mentions: [targetUserId] });
    logActivity(`!warn appliqué pour ${targetUserId} (${newWarningCount}/${CONFIG.maxWarnings})`);
  } catch (err) {
    console.error('Erreur !warn:', err);
  }
}

/**
 * Commande !help / !aide / .menu
 */
async function handleHelpCommand(jid, isAdminUser, senderId = null) {
  try {
    const userPhone = sock?.user?.id ? `+${sock.user.id.split('@')[0].split(':')[0]}` : (lastConnectedPhone ? `+${lastConnectedPhone}` : '');

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
    logActivity(`Menu d'aide envoyé avec succès.`);
  } catch (err) {
    console.error('Erreur !help:', err);
    logActivity(`Erreur envoi help: ${err.message}`, 'warn');
  }
}

/**
 * Commande !status / .status / .info / .bot
 */
async function handleStatusCommand(jid, groupData = null) {
  try {
    const userPhone = sock?.user?.id ? `+${sock.user.id.split('@')[0].split(':')[0]}` : (lastConnectedPhone ? `+${lastConnectedPhone}` : 'Non connecté');
    const userName = sock?.user?.name || lastConnectedName || 'Bot WhatsApp';
    const groupName = groupData?.subject || 'Discussion Privée';

    let text = `⎔⋅• ━ ╼━ ╼╃ ⌬〔 🌿 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
    text += `       🏰 *حـالـة الـحـسـاب والـبـوت* 🏰\n`;
    text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 🌿 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n\n`;
    text += `📱 *الـواتـسـاب الـمـتـصـل* : ${userPhone}\n`;
    text += `👤 *اسـم الـحـسـاب* : ${userName}\n`;
    text += `⚡ *حـالـة الـخـادم* : 🟢 مـتـصـل ونـشـط 24/7\n`;
    text += `🏰 *الـمـجـمـوعـة الـحـالـيـة* : ${groupName}\n`;
    text += `🛡️ *أنـظـمـة الـحـمـايـة* : مـضـاد الـروابـط + مـضـاد جـهـات الاتـصـال مـفـعـل\n`;
    text += `⚠️ *الـحـد الأقـصـى لـلإنـذارات* : ${CONFIG.maxWarnings}\n\n`;
    text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚔️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
    text += `       🏰 *PARADIS EMPIRE* 🏰`;

    await sock.sendMessage(jid, { text });
    logActivity(`Statut du compte envoyé sur WhatsApp.`);
  } catch (err) {
    console.error('Erreur !status:', err);
  }
}

/**
 * Commande !regles / !rules / .regles
 */
async function handleRulesCommand(jid) {
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

/**
 * Commande !warnings / !warns
 */
async function handleCheckWarningsCommand(jid, messageText, senderId, groupData) {
  try {
    const match = messageText.match(/@(\d+)/);
    let targetUserId = senderId;

    if (match) {
      targetUserId = match[1] + '@s.whatsapp.net';
    }

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

/**
 * Commande !resetwarn
 */
async function handleResetWarnCommand(jid, messageText, groupData) {
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
    logActivity(`Avertissements réinitialisés pour ${targetUserId}`);
  } catch (err) {
    console.error('Erreur !resetwarn:', err);
  }
}

/**
 * Commande !kick
 */
async function handleManualKickCommand(jid, messageText, groupData) {
  try {
    const match = messageText.match(/@(\d+)/);
    if (!match) {
      await sock.sendMessage(jid, { text: '❌ Syntaxe incorrecte. Exemple : *!kick @numéro*' });
      return;
    }

    const targetUserId = match[1] + '@s.whatsapp.net';
    const targetMention = formatMention(targetUserId);

    await sock.sendMessage(jid, { text: `👋 Expulsion de ${targetMention} par un administrateur...`, mentions: [targetUserId] });
    await handleUserKick(jid, targetUserId, groupData);
    logActivity(`!kick manuel appliqué pour ${targetUserId}`);
  } catch (err) {
    console.error('Erreur !kick:', err);
  }
}

/**
 * Expulser un participant
 */
async function handleUserKick(jid, userId, groupData) {
  try {
    await sock.groupParticipantsUpdate(jid, [userId], 'remove');
    resetWarnings(jid, userId);
  } catch (err) {
    console.error('Erreur expulsion:', err);
  }
}

/**
 * Mises à jour des groupes
 */
async function handleGroupUpdate(updates) {
  for (const update of updates) {
    logActivity(`Mise à jour groupe ${update.id}`);
  }
}

// ----------------------------------------------------
// Serveur Web Express & API de Liaison WhatsApp
// ----------------------------------------------------

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/**
 * API: Obtenir le statut actuel et les informations du compte connecté
 */
app.get('/api/status', async (req, res) => {
  let groups = [];
  if (connectionStatus === 'connected' && sock) {
    try {
      const groupData = await sock.groupFetchAllParticipating();
      groups = Object.values(groupData).map((g) => ({
        id: g.id,
        name: g.subject || 'Groupe sans nom',
        participantsCount: g.participants?.length || 0,
        isAdmin: g.participants?.some(
          (p) => normalizeJid(p.id) === normalizeJid(sock?.user?.id) && (p.admin === 'admin' || p.admin === 'superadmin')
        ),
      }));
    } catch (_) {}
  }

  const currentPhone = sock?.user?.id ? sock.user.id.split('@')[0].split(':')[0] : lastConnectedPhone;

  res.json({
    status: connectionStatus,
    pairingCode: currentPairingCode,
    targetGroup: CONFIG.targetGroupName,
    user: currentPhone ? {
      id: sock?.user?.id || `${currentPhone}@s.whatsapp.net`,
      phone: `+${currentPhone}`,
      name: sock?.user?.name || lastConnectedName || 'Bot WhatsApp',
    } : null,
    connectedAt: connectedAt,
    groups: groups,
    logs: activityLogs.slice(-25),
  });
});

/**
 * API: Demander un code d'association (Pairing Code pour n'importe quel téléphone)
 * 
 * STRATÉGIE: Au lieu de créer le socket puis d'attendre ws.isOpen (qui ne garantit
 * PAS que le handshake Noise est fini), on passe le numéro de téléphone à
 * initializeSocket(). Le handler connection.update intercepte l'événement QR
 * (qui signifie que Baileys est prêt) et appelle requestPairingCode à ce moment
 * exact. Le résultat est retourné via une Promise.
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

    // Fermer proprement toute connexion existante
    if (sock) {
      logActivity(`Changement de téléphone vers +${cleanPhone} : fermeture de la session précédente...`);
      try {
        await sock.logout().catch(() => {});
      } catch (_) {}
      try {
        sock.ev.removeAllListeners();
        sock.ws?.close();
      } catch (_) {}
      sock = null;
    }

    // Réinitialiser les identifiants locaux pour un jumelage propre
    cleanAuthDir();
    currentPairingCode = null;
    updateStatus('connecting');

    // Créer la Promise qui sera résolue quand requestPairingCode réussira
    // depuis le handler connection.update (quand l'événement QR arrive)
    const pairingPromise = new Promise((resolve, reject) => {
      pairingReadyResolve = resolve;
      pairingReadyReject = reject;

      // Timeout de sécurité: 30 secondes max
      setTimeout(() => {
        if (pairingReadyReject) {
          reject(new Error('Délai dépassé (30s) : impossible de joindre WhatsApp. Réessayez.'));
          pairingReadyResolve = null;
          pairingReadyReject = null;
        }
      }, 30000);
    });

    // Lancer le socket avec le numéro de pairing — le handler va appeler
    // requestPairingCode dès que l'événement QR est émis
    await initializeSocket(cleanPhone);

    // Attendre que le code soit généré (résolu depuis handleConnectionUpdate)
    const code = await pairingPromise;

    currentPairingCode = code;
    updateStatus('awaiting_code');

    logActivity(`Code d'association généré avec succès pour +${cleanPhone}: ${code}`, 'system');

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
 * API: Annuler la tentative de liaison en cours
 */
app.post('/api/cancel-pairing', (req, res) => {
  currentPairingCode = null;
  pairingReadyResolve = null;
  pairingReadyReject = null;
  if (connectionStatus !== 'connected') {
    updateStatus('disconnected');
  }
  res.json({ success: true });
});

/**
 * API: Déconnecter le bot et réinitialiser les identifiants
 */
app.post('/api/disconnect', async (req, res) => {
  try {
    logActivity('Déconnexion demandée depuis l\'interface web...', 'warn');

    if (sock) {
      try {
        await sock.logout();
      } catch (_) {}
      try {
        sock.ev.removeAllListeners();
        sock.ws?.close();
      } catch (_) {}
    }

    // Supprimer les fichiers d'authentification pour repartir à neuf
    if (fs.existsSync(AUTH_DIR)) {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      fs.mkdirSync(AUTH_DIR, { recursive: true });
    }

    sock = null;
    currentPairingCode = null;
    connectedAt = null;
    lastConnectedPhone = null;
    lastConnectedName = null;
    updateStatus('disconnected');

    res.json({ success: true, message: 'Bot déconnecté et session supprimée.' });
  } catch (error) {
    console.error('Erreur déconnexion:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * API: Server-Sent Events (SSE) pour les notifications en temps réel
 */
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  sseClients.add(res);

  // Envoyer l'état actuel immédiatement
  res.write(`data: ${JSON.stringify({ type: 'status', status: connectionStatus, code: currentPairingCode })}\n\n`);

  req.on('close', () => {
    sseClients.delete(res);
  });
});

/**
 * Démarrage du serveur et du bot
 */
async function startServer() {
  try {
    app.listen(CONFIG.port, () => {
      console.log('\n╔════════════════════════════════════════════════════════════════╗');
      console.log('║               🤖 WHATSAPP BOT MODÉRATEUR                      ║');
      console.log('╠════════════════════════════════════════════════════════════════╣');
      console.log(`║ 🌐 Interface Web : http://localhost:${CONFIG.port}                     ║`);
      console.log('║ 📱 Ouvrez l\'URL ci-dessus pour lier votre compte WhatsApp      ║');
      console.log('╚════════════════════════════════════════════════════════════════╝\n');
    });

    // NE PAS initialiser le socket au démarrage quand il n'y a pas de credentials
    // Cela évite un cycle connect/close inutile sur Render (pas de persistance)
    // Le socket sera créé quand l'utilisateur cliquera "Générer le code"
    const credsPath = path.join(AUTH_DIR, 'creds.json');
    if (fs.existsSync(credsPath)) {
      try {
        const creds = JSON.parse(fs.readFileSync(credsPath, 'utf-8'));
        if (creds.registered) {
          logActivity('Session existante détectée, reconnexion automatique...');
          await initializeSocket();
        } else {
          logActivity('En attente de liaison — cliquez "Générer le code" sur la page web.');
          updateStatus('disconnected');
        }
      } catch (_) {
        logActivity('En attente de liaison — cliquez "Générer le code" sur la page web.');
        updateStatus('disconnected');
      }
    } else {
      logActivity('Aucune session trouvée — cliquez "Générer le code" sur la page web.');
      updateStatus('disconnected');
    }
  } catch (error) {
    console.error('Erreur critique au démarrage:', error);
    process.exit(1);
  }
}

// Arrêt propre
process.on('SIGINT', () => {
  logActivity('Arrêt du serveur et fermeture des connexions...');
  try { sock?.ws?.close(); } catch (_) {}
  process.exit(0);
});

startServer();
