/**
 * Bot de Modération WhatsApp avec Baileys et Interface Web de Liaison par Code
 * Stack: Baileys, Express, SQLite, Pino
 */

import 'dotenv/config';
import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import { initializeDatabase, addWarning, getWarningCount, resetWarnings } from './db.js';
import { isAdmin, extractMessage, containsUrl, isGroupMessage, formatMention } from './utils/helpers.js';

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
const activityLogs = [];
const sseClients = new Set();

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
 * Initialiser la socket WhatsApp Baileys
 */
async function initializeSocket() {
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
      browser: ['Ubuntu', 'Chrome', '122.0.0.0'], // Profil navigateur compatible pairing code
      syncFullHistory: false,
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
    });

    // Sauvegarde automatique des crédits
    sock.ev.on('creds.update', saveCredsFunc);

    // Mises à jour de la connexion
    sock.ev.on('connection.update', handleConnectionUpdate);

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
 */
async function handleConnectionUpdate(update) {
  const { connection, lastDisconnect } = update;

  if (connection === 'connecting') {
    if (connectionStatus !== 'awaiting_code') {
      updateStatus('connecting');
    }
    logActivity('Connexion au serveur WhatsApp en cours...');
  }

  if (connection === 'open') {
    connectionAttempts = 0;
    currentPairingCode = null;
    updateStatus('connected');
    const userPhone = sock?.user?.id ? sock.user.id.split('@')[0].split(':')[0] : 'Inconnu';
    logActivity(`✅ Bot connecté avec succès sur le numéro +${userPhone} !`, 'system');
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
      logActivity('Session déconnectée. Veuillez reconnecter le bot via la page web.', 'warn');
    } else {
      // Reconnexion automatique si ce n'est pas une déconnexion volontaire
      connectionAttempts++;
      const delay = Math.min(connectionAttempts * 3000, 15000);
      logActivity(`Reconnexion automatique dans ${delay / 1000}s... (tentative ${connectionAttempts})`);
      setTimeout(() => {
        initializeSocket().catch(() => {});
      }, delay);
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
      if (msg.key.fromMe || !msg.message) continue;

      const jid = msg.key.remoteJid;
      const senderId = msg.key.participant;

      if (!isGroupMessage(jid)) continue;

      const messageText = extractMessage(msg);
      if (!messageText) continue;

      // Récupérer les informations du groupe
      let groupData;
      try {
        groupData = await sock.groupMetadata(jid);
      } catch (_) {
        continue;
      }

      const senderIsAdmin = isAdmin(senderId, groupData);

      // 1. Module Anti-Lien
      if (containsUrl(messageText) && !senderIsAdmin) {
        await handleAntiLink(jid, senderId, msg.key.id, groupData);
      }

      // 2. Module Anti-Contact
      const isContact = msg.message.contactMessage || msg.message.contactsArrayMessage;
      if (isContact && !senderIsAdmin) {
        await handleAntiContact(jid, senderId, msg.key.id, groupData);
      }

      // 3. Commandes du Bot
      const lowerText = messageText.trim().toLowerCase();

      // Commande !help / !aide (tous les membres)
      if (lowerText === '!help' || lowerText === '!aide') {
        await handleHelpCommand(jid, senderIsAdmin);
        continue;
      }

      // Commande !regles / !rules (tous les membres)
      if (lowerText === '!regles' || lowerText === '!rules') {
        await handleRulesCommand(jid);
        continue;
      }

      // Commande !warnings / !warns (consulter les avertissements)
      if (lowerText.startsWith('!warnings') || lowerText.startsWith('!warns')) {
        await handleCheckWarningsCommand(jid, messageText, senderId, groupData);
        continue;
      }

      // Commande !warn (Admins uniquement)
      if (lowerText.startsWith('!warn ') && senderIsAdmin) {
        await handleWarnCommand(jid, messageText, groupData);
        continue;
      }

      // Commande !resetwarn (Admins uniquement)
      if (lowerText.startsWith('!resetwarn') && senderIsAdmin) {
        await handleResetWarnCommand(jid, messageText, groupData);
        continue;
      }

      // Commande !kick (Admins uniquement)
      if (lowerText.startsWith('!kick') && senderIsAdmin) {
        await handleManualKickCommand(jid, messageText, groupData);
        continue;
      }
    }
  } catch (error) {
    console.error('Erreur traitement messages:', error);
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
 * Commande !help / !aide
 */
async function handleHelpCommand(jid, isAdminUser) {
  try {
    let helpText = `🤖 *BOT DE MODÉRATION - COMMANDES*\n\n`;
    helpText += `📌 *Commandes Membres :*\n`;
    helpText += `• *!help* : Afficher la liste des commandes\n`;
    helpText += `• *!regles* : Consulter les règles du groupe\n`;
    helpText += `• *!warnings* : Voir vos avertissements actuels\n\n`;

    if (isAdminUser) {
      helpText += `👑 *Commandes Administrateur :*\n`;
      helpText += `• *!warn @membre* : Ajouter un avertissement (+ kick à ${CONFIG.maxWarnings})\n`;
      helpText += `• *!warnings @membre* : Voir les avertissements d'un membre\n`;
      helpText += `• *!resetwarn @membre* : Remettre à zéro les avertissements\n`;
      helpText += `• *!kick @membre* : Expulser immédiatement un membre\n\n`;
    }

    helpText += `🛡️ *Protections automatiques :*\n`;
    helpText += `• *Anti-Lien* : Liens supprimés automatiquement (${CONFIG.maxWarnings} avertissements = exclusion)\n`;
    helpText += `• *Anti-Contact* : Partage de contact interdit (exclusion immédiate)`;

    await sock.sendMessage(jid, { text: helpText });
  } catch (err) {
    console.error('Erreur !help:', err);
  }
}

/**
 * Commande !regles / !rules
 */
async function handleRulesCommand(jid) {
  try {
    let rulesText = `📜 *RÈGLES OFFICIELLES DU GROUPE*\n\n`;
    rulesText += `1️⃣ *Aucun lien externe* : Les liens sont strictement interdits et supprimés automatiquement.\n`;
    rulesText += `2️⃣ *Aucun partage de contact* : Partager une fiche contact entraîne une expulsion immédiate.\n`;
    rulesText += `3️⃣ *Système d'avertissements* : Vous avez droit à ${CONFIG.maxWarnings} avertissements maximum avant expulsion définitive.\n`;
    rulesText += `4️⃣ *Respect et courtoisie* : Restez poli et courtois envers tous les membres.\n\n`;
    rulesText += `_Modération automatique active 24/7 par le bot._`;

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
 * API: Obtenir le statut actuel
 */
app.get('/api/status', (req, res) => {
  res.json({
    status: connectionStatus,
    pairingCode: currentPairingCode,
    targetGroup: CONFIG.targetGroupName,
    user: sock?.user ? {
      id: sock.user.id,
      name: sock.user.name || 'Bot WhatsApp'
    } : null,
    logs: activityLogs.slice(-20),
  });
});

/**
 * API: Demander un code d'association (Pairing Code)
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

    if (connectionStatus === 'connected') {
      return res.status(400).json({ success: false, error: 'Le bot est déjà connecté.' });
    }

    logActivity(`Demande de code de liaison pour le numéro +${cleanPhone}...`);

    // S'assurer que la socket est initialisée
    if (!sock || !sock.ws || sock.ws.readyState === 3 /* CLOSED */) {
      await initializeSocket();
    }

    // Demander le code de jumelage avec boucle de résilience
    let code = null;
    let lastErr = null;

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        if (!sock || !sock.ws || sock.ws.readyState === 3 /* CLOSED */) {
          await initializeSocket();
          await new Promise((resolve) => setTimeout(resolve, 2500));
        }

        code = await sock.requestPairingCode(cleanPhone);
        if (code) break;
      } catch (err) {
        lastErr = err;
        logActivity(`Tentative ${attempt}/3 code de liaison: ${err.message || err}`, 'warn');
        // Si besoin de réinitialiser la socket avant réessai
        if (attempt < 3) {
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      }
    }

    if (!code) {
      throw lastErr || new Error('Impossible d\'obtenir le code auprès des serveurs WhatsApp.');
    }

    currentPairingCode = code;
    updateStatus('awaiting_code');

    logActivity(`Code d'association généré avec succès: ${code}`, 'system');

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

    currentPairingCode = null;
    updateStatus('disconnected');

    // Réinitialiser la socket pour permettre une nouvelle connexion
    setTimeout(() => {
      initializeSocket().catch(() => {});
    }, 1000);

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

    // Initialiser la socket WhatsApp
    await initializeSocket();
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
