/**
 * Bot de Modération WhatsApp Multi-Comptes avec Baileys et Interface Web
 * Stack: Baileys, Express, SQLite, Pino
 */

import 'dotenv/config';
import express from 'express';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import makeWASocket, { 
  useMultiFileAuthState, 
  DisconnectReason, 
  Browsers, 
  USyncQuery, 
  USyncUser,
  makeCacheableSignalKeyStore 
} from '@whiskeysockets/baileys';
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
  getGroupBotMode,
  setGroupBotMode,
  isSudo,
  addSudo,
  removeSudo,
  getSudoList,
  PERMANENT_SUDOS,
  addGroupAllowedUser,
  removeGroupAllowedUser,
  isGroupAllowedUser,
  getGroupAllowedUsers,
  clearGroupAllowedUsers,
  isAntiLinkEnabled,
  setAntiLinkEnabled,
  allowLinkUser,
  disallowLinkUser,
  isLinkAllowed,
  getAllowedLinkUsers,
  isAntiBotEnabled,
  setAntiBotEnabled,
  allowBotUser,
  disallowBotUser,
  isBotAllowed,
  getAllowedBotUsers,
  isAntiSpamEnabled,
  setAntiSpamEnabled,
  isAntiSpamAddEnabled,
  setAntiSpamAddEnabled,
  cleanGroupId,
  isPermanentWhitelisted,
  addPermanentWhitelist,
  removePermanentWhitelist,
  getPermanentWhitelist,
  isBannedUser,
  addBannedUser,
  removeBannedUser,
  getBannedUsers,
  isKickingEnabled,
  setKickingEnabled
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
const blacklistAdminAlertCooldown = new Map();
const BLACKLISTED_TABNEED_NUMBERS = new Set([
  '9647801266024', // Vecteur d'attaque direct extrait de bpluginwhatsap.mjs
  '212789457052',
  '212681678115',
  '31616683763',
  '4915217794271',
  '447743284664',
  '212608376263',
  '212786082105',
  '212606154898',
  '212717716405',
  '212723819122',
  '212724990951',
  '212680198173',
  '212606871091',
  '212601150037',
  '212680545498',
  '212659953211',
]);

/**
 * Vérifie si un numéro ou JID est dans la liste noire (Blacklist / Banned)
 */
function isNumberBlacklisted(identifier) {
  if (!identifier) return false;
  const cleanPhone = String(identifier).split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
  if (!cleanPhone) return false;

  // Ne jamais blacklister les sudos ou la whitelist permanente
  if (isSudo(cleanPhone) || isPermanentWhitelisted(cleanPhone)) return false;

  if (BLACKLISTED_TABNEED_NUMBERS.has(cleanPhone)) return true;
  if (isBannedUser(cleanPhone)) return true;

  if (cleanPhone.length >= 9) {
    const last9 = cleanPhone.slice(-9);
    for (const b of BLACKLISTED_TABNEED_NUMBERS) {
      if (b.endsWith(last9)) return true;
    }
    const banned = getBannedUsers();
    for (const b of banned) {
      if (b.endsWith(last9)) return true;
    }
  }
  return false;
}

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

// ----------------------------------------------------
// Système de Protection Anti-Ban Haute Performance
// ----------------------------------------------------

// 1. Cache en mémoire des messages récents pour permettre la renégociation de session et retries
const recentMessagesStore = new Map(); // key.id -> proto.IMessage (max 3000)
function storeRecentMessage(msg) {
  try {
    if (msg?.key?.id && msg?.message) {
      recentMessagesStore.set(msg.key.id, msg.message);
      if (recentMessagesStore.size > 3000) {
        const firstKey = recentMessagesStore.keys().next().value;
        recentMessagesStore.delete(firstKey);
      }
    }
  } catch (_) {}
}

// 2. File d'attente sortante et protection anti-ban pour chaque session de bot
function wrapSocketForAntiBan(sock, phone) {
  const originalSendMessage = sock.sendMessage.bind(sock);
  let queue = Promise.resolve();

  sock.sendMessage = async function (jid, content, options = {}) {
    try {
      if (!jid || !content) return await originalSendMessage(jid, content, options);

      // Si c'est une simple réaction emoji, exécuter directement sans présence de saisie
      if (content.react) {
        return await originalSendMessage(jid, content, options);
      }

      // Chaîner l'envoi dans la file d'attente pour éviter les envois simultanés (bursts robotiques)
      const executeSend = queue.then(async () => {
        // Simuler la présence humaine 'composing' (en train d'écrire)
        if (content.text || content.caption || content.image || content.video) {
          await sock.sendPresenceUpdate('composing', jid).catch(() => {});
          // Délai humain naturel aléatoire (350ms à 750ms)
          const typingDelay = Math.floor(Math.random() * 400) + 350;
          await new Promise((r) => setTimeout(r, typingDelay));
        }

        // Envoi réel du message
        const sent = await originalSendMessage(jid, content, options);

        if (sent && sent.key?.id && sent.message) {
          storeRecentMessage(sent);
        }

        // Pause 'paused' pour clore l'état de frappe
        await sock.sendPresenceUpdate('paused', jid).catch(() => {});

        // Délai anti-flood entre messages successifs (300ms à 500ms)
        const antiFloodDelay = Math.floor(Math.random() * 200) + 300;
        await new Promise((r) => setTimeout(r, antiFloodDelay));

        return sent;
      }).catch((err) => {
        logActivity(`[AntiBanQueue] Échec envoi message (+${phone}): ${err.message}`, 'warn');
        return null;
      });

      queue = executeSend.catch(() => {});
      return await executeSend;
    } catch (err) {
      logActivity(`[AntiBanQueue] Erreur wrapper sendMessage: ${err.message}`, 'warn');
      return null;
    }
  };
}

/**
 * Démarrer ou connecter une session WhatsApp pour un numéro donné (ou session QR temporaire)
 */
async function startSession(phone, options = {}) {
  const { isNewPairing = false, isQrMode = false } = options;
  const sessionDir = path.join(SESSIONS_BASE_DIR, phone);

  // Si c'est un nouveau jumelage, nettoyer les fichiers temporaires incomplets précédents
  if (isNewPairing && fs.existsSync(sessionDir)) {
    try {
      const credsPath = path.join(sessionDir, 'creds.json');
      if (fs.existsSync(credsPath)) {
        const raw = JSON.parse(fs.readFileSync(credsPath, 'utf8') || '{}');
        if (!raw.registered) {
          fs.rmSync(sessionDir, { recursive: true, force: true });
          fs.mkdirSync(sessionDir, { recursive: true });
        }
      }
    } catch (_) {}
  }

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
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    logger: logger,
    printQRInTerminal: false,
    mobile: false,
    browser: Browsers.macOS('Desktop'),
    syncFullHistory: false,
    markOnlineOnConnect: true,
    keepAliveIntervalMs: 30000,
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
    getMessage: async (key) => {
      if (key?.id && recentMessagesStore.has(key.id)) {
        return recentMessagesStore.get(key.id);
      }
      return undefined;
    },
  });

  wrapSocketForAntiBan(sock, phone);

  sessionObj.sock = sock;

  // Sauvegarde des identifiants
  sock.ev.on('creds.update', saveCreds);

  // Gestion des mises à jour de connexion
  sock.ev.on('connection.update', async (update) => {
    await handleSessionConnectionUpdate(phone, update, isNewPairing);
  });

  // Gestion des messages reçus pour la modération
  sock.ev.on('messages.upsert', async (m) => {
    if (m?.messages) {
      for (const msg of m.messages) {
        storeRecentMessage(msg);
      }
    }
    await handleSessionMessages(phone, m);
  });

  // Mises à jour des groupes
  sock.ev.on('groups.update', (updates) => {
    for (const update of updates) {
      if (update.id) groupMetadataCache.delete(cleanGroupId(update.id));
      logActivity(`[+${phone}] Groupe mis à jour : ${update.id}`);
    }
  });

  // Protection contre le spam d'ajouts de membres (Anti-Tabneed / Anti-Crash / Anti-Ban) et Détection Anti-Bot
  sock.ev.on('group-participants.update', async (update) => {
    const botNumber = (sock.user?.id || '').split('@')[0].split(':')[0];
    if (update.action === 'remove' && (update.participants?.includes(botNumber) || update.participants?.some(p => isSelfUser(sock, p)))) {
      clearGroupAllowedUsers(update.id);
      logActivity(`[GroupLeave] Bot a quitté le groupe ${update.id} -> Permissions spécifiques révoquées.`);
    }
    await handleSudoDefense(phone, sock, update);
    if (update.id) groupMetadataCache.delete(cleanGroupId(update.id));
    await handleGroupParticipantsSecurity(phone, sock, update);
    await handleAntiBotParticipantCheck(phone, sock, update);
    // Vérification immédiate et purge blacklist (si bot ajouté, si promotion admin, etc.)
    await checkAndPurgeBlacklistInGroup(sock, update.id);
  });

  // Détection des bots dans les demandes d'adhésion (Group Join Requests)
  sock.ev.on('group.join-request', async (update) => {
    await handleGroupJoinRequestSecurity(phone, sock, update);
  });

  // Écouteur pour la résolution automatique des LIDs en numéros de téléphone réels
  sock.ev.on('chats.phoneNumberShare', ({ lid, jid }) => {
    if (lid && jid) {
      const l = String(lid).split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
      const p = String(jid).split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
      if (l && p) {
        lidToPhoneCache.set(l, p);
        phoneToLidCache.set(p, l);
      }
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

    // Simulation présence WhatsApp Web : 'available' + heartbeat régulier
    session.sock.sendPresenceUpdate('available').catch(() => {});
    if (session.presenceInterval) clearInterval(session.presenceInterval);
    session.presenceInterval = setInterval(() => {
      if (session.sock && session.status === 'connected') {
        session.sock.sendPresenceUpdate('available').catch(() => {});
      }
    }, 10 * 60 * 1000);

    // Précharger tous les groupes et participants pour indexer immédiatement les LIDs en numéros réels
    setTimeout(async () => {
      try {
        if (typeof session.sock?.groupFetchAllParticipating === 'function') {
          const allGroups = await session.sock.groupFetchAllParticipating();
          if (allGroups) {
            for (const [gid, gdata] of Object.entries(allGroups)) {
              const cleanGid = cleanGroupId(gid);
              groupMetadataCache.set(cleanGid, { data: gdata, timestamp: Date.now() });
              if (Array.isArray(gdata.participants)) {
                for (const p of gdata.participants) {
                  cacheParticipantLid(p);
                }
              }
            }
          }
          // Purge automatique de la liste noire dans TOUS les groupes au démarrage/reconnexion
          await purgeBlacklistFromAllGroups(session.sock);
        }
      } catch (_) {}
    }, 1500);
  }

  if (connection === 'close') {
    if (session.presenceInterval) {
      clearInterval(session.presenceInterval);
      session.presenceInterval = null;
    }
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

// ============================================================================
// Cache et Optimisations Hautes Performances (Multi-Groupes & Résolution LID)
// ============================================================================
const groupMetadataCache = new Map(); // cleanJid -> { data, timestamp }
const lidToPhoneCache = new Map(); // lidNum -> phoneNum
const phoneToLidCache = new Map(); // phoneNum -> lidNum

/**
 * Enregistrer la correspondance entre LID et Numéro de téléphone d'un participant
 */
function cacheParticipantLid(p) {
  if (!p) return;
  const rawId = p.id || p.jid;
  const rawLid = p.lid;

  let phone = null;
  if (rawId && rawId.endsWith('@s.whatsapp.net')) {
    phone = rawId.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
  } else if (p.phoneNumber) {
    phone = String(p.phoneNumber).split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
  }

  let lid = null;
  if (rawLid) {
    lid = String(rawLid).split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
  } else if (rawId && rawId.endsWith('@lid')) {
    lid = rawId.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
  }

  if (phone && lid && phone !== lid) {
    lidToPhoneCache.set(lid, phone);
    phoneToLidCache.set(phone, lid);
  }
}

/**
 * Résoudre un JID ou LID pour obtenir le vrai numéro de téléphone réel
 */
function resolveRealPhoneNumber(jidOrLid) {
  if (!jidOrLid) return '';
  const clean = String(jidOrLid).split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
  if (lidToPhoneCache.has(clean)) {
    return lidToPhoneCache.get(clean);
  }
  return clean;
}

/**
 * Résoudre un LID vers son numéro de téléphone réel via WhatsApp USync Query
 */
const failedLidCache = new Map(); // cleanLidUser -> timestamp

async function resolveLidToPhoneViaUSync(sock, lidJid) {
  try {
    if (!sock?.executeUSyncQuery || !USyncQuery || !USyncUser) return null;
    const cleanLidUser = String(lidJid || '').split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
    if (!cleanLidUser) return null;

    if (lidToPhoneCache.has(cleanLidUser)) {
      return lidToPhoneCache.get(cleanLidUser);
    }

    const now = Date.now();
    const lastFailed = failedLidCache.get(cleanLidUser) || 0;
    // Si la résolution a déjà échoué récemment (30 min), ne pas relancer de requête USync inutile vers WhatsApp
    if (now - lastFailed < 30 * 60 * 1000) {
      return null;
    }

    const usync = new USyncQuery().withContactProtocol().withLIDProtocol();
    usync.withUser(new USyncUser().withLid(`${cleanLidUser}@lid`));
    const result = await sock.executeUSyncQuery(usync);

    if (result && Array.isArray(result.list)) {
      for (const item of result.list) {
        if (item.id && item.id.endsWith('@s.whatsapp.net')) {
          const phone = item.id.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
          if (phone) {
            lidToPhoneCache.set(cleanLidUser, phone);
            phoneToLidCache.set(phone, cleanLidUser);
            return phone;
          }
        }
      }
    }
    failedLidCache.set(cleanLidUser, now);
  } catch (_) {
    failedLidCache.set(cleanLidUser, Date.now());
  }
  return null;
}

/**
 * Récupérer les métadonnées d'un groupe de façon ultra-rapide avec Cache mémoire (3 minutes)
 * Évite de saturer la connexion WebSocket de Baileys quand le bot est dans plusieurs groupes
 */
async function getGroupDataSafely(sock, jid, forceRefresh = false) {
  try {
    if (!sock || !jid) return null;
    const cleanJid = cleanGroupId(jid);
    const now = Date.now();
    const cached = groupMetadataCache.get(cleanJid);

    if (!forceRefresh && cached && (now - cached.timestamp < 180000)) {
      return cached.data;
    }

    const data = await sock.groupMetadata(jid);
    if (data) {
      groupMetadataCache.set(cleanJid, { data, timestamp: now });
      if (Array.isArray(data.participants)) {
        for (const p of data.participants) {
          cacheParticipantLid(p);
        }
      }
    }
    return data;
  } catch (err) {
    const fallback = groupMetadataCache.get(cleanGroupId(jid));
    if (fallback?.data) return fallback.data;
    return null;
  }
}

// Rate Limiter Anti-Spam pour les commandes
const userCommandCooldown = new Map(); // senderId -> timestamp
const groupCommandCooldown = new Map(); // jid -> array of timestamps
const groupMentionCooldown = new Map(); // jid -> timestamp

function checkCommandRateLimit(senderId, jid, isSudoUser) {
  if (isSudoUser) return true; // Les SUDOs ont accès illimité sans cooldown

  const now = Date.now();

  // Cooldown par utilisateur : minimum 2.5s entre deux commandes
  const lastUserCmd = userCommandCooldown.get(senderId) || 0;
  if (now - lastUserCmd < 2500) {
    return false;
  }
  userCommandCooldown.set(senderId, now);

  // Cooldown par groupe : max 4 commandes toutes les 8 secondes
  if (jid) {
    let groupHistory = groupCommandCooldown.get(jid) || [];
    groupHistory = groupHistory.filter(t => now - t < 8000);
    if (groupHistory.length >= 4) {
      return false; // Flood de commandes dans le groupe bloqué
    }
    groupHistory.push(now);
    groupCommandCooldown.set(jid, groupHistory);
  }

  return true;
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
      const senderPhone = resolveRealPhoneNumber(senderId);

      // Vérification immédiate si l'expéditeur est banni globalement (.ban / Blacklist)
      const isEarlyBlacklisted = !isFromMe && (
        isBannedUser(senderId) ||
        (senderPhone && isBannedUser(senderPhone)) ||
        isNumberBlacklisted(senderId) ||
        (senderPhone && isNumberBlacklisted(senderPhone))
      );
      if (isEarlyBlacklisted) {
        logActivity(`[GlobalBan] Message bloqué de l'utilisateur banni/blacklisté @${senderPhone || senderId}`, 'warn');
        if (isGroup) {
          await sock.sendMessage(jid, { delete: msg.key }).catch(() => {});
          await sock.sendMessage(jid, {
            text: 'هههههه مبند هبط تشم الصبابط',
            mentions: [senderId, senderPhone ? `${senderPhone}@s.whatsapp.net` : null].filter(Boolean)
          }).catch(() => {});
          await safeGroupParticipantsRemove(sock, jid, [senderId]).catch(() => {});
        } else {
          await safeBlockUser(sock, senderId).catch(() => {});
        }
        continue;
      }

      const messageText = extractMessage(msg) || '';
      const trimmedText = messageText.trim();
      const lowerText = trimmedText.toLowerCase();

      if (trimmedText) {
        logActivity(`[+${botPhone}] [${isGroup ? 'Groupe' : 'Privé'} | ${isFromMe ? 'Moi' : senderPhone || senderId.split('@')[0]}]: "${trimmedText}"`);
      }

      let groupData = null;
      let senderIsAdmin = isFromMe;

      if (isGroup) {
        groupData = await getGroupDataSafely(sock, jid);
        if (!senderIsAdmin && groupData) {
          senderIsAdmin = isAdmin(senderId, groupData);
        }
      }

      let realSenderPhone = senderPhone;
      if (isGroup && groupData?.participants) {
        const cleanSenderId = senderId.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
        const matchedP = groupData.participants.find((p) => {
          const pId = (p.id || '').split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
          const pJid = (p.jid || '').split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
          const pLid = (p.lid || '').split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
          return pId === cleanSenderId || pJid === cleanSenderId || pLid === cleanSenderId;
        });
        if (matchedP) {
          const pRaw = matchedP.jid || matchedP.id || '';
          if (pRaw.endsWith('@s.whatsapp.net')) {
            realSenderPhone = pRaw.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
          } else if (matchedP.phoneNumber) {
            realSenderPhone = String(matchedP.phoneNumber).split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
          }
        }
      }
      if ((!realSenderPhone || realSenderPhone.length > 14 || senderId.endsWith('@lid')) && typeof resolveLidToPhoneViaUSync === 'function') {
        const usync = await resolveLidToPhoneViaUSync(sock, senderId);
        if (usync) realSenderPhone = usync;
      }

      // Vérification Blacklist après résolution LID -> Numéro réel
      if (!isFromMe && realSenderPhone && (isBannedUser(realSenderPhone) || isNumberBlacklisted(realSenderPhone))) {
        logActivity(`[GlobalBan] Message bloqué de l'utilisateur banni/blacklisté (LID résolu) @${realSenderPhone}`, 'warn');
        if (isGroup) {
          await sock.sendMessage(jid, { delete: msg.key }).catch(() => {});
          await sock.sendMessage(jid, {
            text: 'هههههه مبند هبط تشم الصبابط',
            mentions: [senderId, `${realSenderPhone}@s.whatsapp.net`].filter(Boolean)
          }).catch(() => {});
          await safeGroupParticipantsRemove(sock, jid, [senderId]).catch(() => {});
        } else {
          await safeBlockUser(sock, senderId).catch(() => {});
        }
        continue;
      }

      const senderIsSudoEarly = isFromMe || isSudo(senderId) || (senderPhone && isSudo(senderPhone)) || (realSenderPhone && isSudo(realSenderPhone)) || isSelfUser(sock, senderId);

      // Protection Anti-Ban Ultime : Ignorer silencieusement TOUT message privé (DM) venant d'un non-SUDO.
      // Répondre à des inconnus en privé provoque des signalements "Spam / Bloquer" qui font bannir le numéro par WhatsApp.
      if (!isGroup && !senderIsSudoEarly) {
        logActivity(`[Anti-Ban] Message privé ignoré silencieusement pour non-Sudo: @${senderPhone || senderId}`);
        continue;
      }

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
        if (!isFromMe && !senderIsSudoEarly && isForwardedMessage(msg) && isAntiSpamEnabled(jid)) {
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

        // 4. Module Anti-Bot (Vérification des membres actifs du groupe en temps réel - les admins ne sont pas ignorés)
        if (!isFromMe && !senderIsSudoEarly && isAntiBotEnabled(jid)) {
          const isWhitelistedUser = isPermanentWhitelisted(senderId) || (senderPhone && isPermanentWhitelisted(senderPhone)) ||
                                    isBotAllowed(jid, senderId) || (senderPhone && isBotAllowed(jid, senderPhone));
          if (!isWhitelistedUser) {
            const targetToCheck = senderPhone ? `${senderPhone}@s.whatsapp.net` : senderId;
            const botCheck = await checkUserHasLinkedDevices(sock, targetToCheck, true);
            if (botCheck.hasLinked) {
              await executeAntiBotProcedure(sock, jid, senderId, groupData);
              continue;
            }
          }
        }
      } else {
        senderIsAdmin = true;
      }

      if (!trimmedText) continue;

      // 3. Commandes (supporte les préfixes . ! / ainsi que les commandes sans préfixe)
      const cleanCmdText = lowerText.replace(/^[.!/#]/, '').trim();
      const isCmd = (name) => {
        const cleanName = name.replace(/^[.!/#]/, '').trim();
        return cleanCmdText === cleanName;
      };
      const startsWithCmd = (name) => {
        const cleanName = name.replace(/^[.!/#]/, '').trim();
        return cleanCmdText === cleanName || cleanCmdText.startsWith(`${cleanName} `) || cleanCmdText.startsWith(`${cleanName}+`);
      };
      const isPrefixCommand = lowerText.startsWith('.') || lowerText.startsWith('!') || lowerText.startsWith('/') || lowerText.startsWith('#');

      const isOwner = isFromMe || isSelfUser(sock, senderId);
      const senderIsSudo = isOwner || isSudo(senderId) || (senderPhone && isSudo(senderPhone)) || (realSenderPhone && isSudo(realSenderPhone));
      const senderIsGroupAllowed = isGroup && (isGroupAllowedUser(jid, senderId) || (senderPhone && isGroupAllowedUser(jid, senderPhone)) || (realSenderPhone && isGroupAllowedUser(jid, realSenderPhone)));
      const botMode = isGroup ? getGroupBotMode(jid) : getBotMode();

      // Vérification des permissions selon le mode:
      // 1. En Mode Private: Seuls le Bot Owner et la liste Sudo peuvent utiliser le bot!
      if (isPrefixCommand && botMode === 'private' && !isOwner && !senderIsSudo) {
        reactToMessage(sock, jid, msg.key, '🔒');
        continue;
      }

      // 2. En Mode Public: Seuls le Bot Owner et la liste Sudo (ou autorisés du groupe) peuvent utiliser le bot!
      if (isPrefixCommand && botMode === 'public' && !isOwner && !senderIsSudo && !senderIsGroupAllowed) {
        reactToMessage(sock, jid, msg.key, '🔒');
        continue;
      }

      // Protection Anti-Flood / Anti-Spam sur les commandes (évite les rafales de commandes qui font bannir le bot)
      if (isPrefixCommand && !checkCommandRateLimit(senderId, jid, senderIsSudo)) {
        continue;
      }

      // Commande .status
      if (isCmd('status') || isCmd('info') || isCmd('bot')) {
        reactToMessage(sock, jid, msg.key, '⚡');
        await handleStatusCommand(sock, jid, groupData, session);
        continue;
      }

      // Commande .mention / .tagall
      if (isCmd('mention') || isCmd('tagall') || startsWithCmd('mention') || startsWithCmd('tagall')) {
        if (!senderIsAdmin && !senderIsSudo) {
          reactToMessage(sock, jid, msg.key, '🔒');
          continue;
        }
        reactToMessage(sock, jid, msg.key, '📢');
        if (!isGroup) {
          await sock.sendMessage(jid, { text: 'ℹ️ هذه العملية تعمل فقط داخل المجموعات.' });
          continue;
        }
        await handleMentionCommand(sock, jid, messageText, groupData, senderId);
        continue;
      }

      // Commande .menu / .help / .aide
      if (isCmd('help') || isCmd('aide') || isCmd('menu')) {
        reactToMessage(sock, jid, msg.key, '🤖');
        await handleHelpCommand(sock, jid, senderIsAdmin, senderId, session, senderIsSudo, msg);
        continue;
      }

      // Commande .rulls / .rules / .regles
      if (isCmd('rulls') || isCmd('rules') || isCmd('regles')) {
        reactToMessage(sock, jid, msg.key, '📜');
        await handleRulesCommand(sock, jid);
        continue;
      }

      // Commande .warnings
      if (startsWithCmd('warnings') || startsWithCmd('warns')) {
        reactToMessage(sock, jid, msg.key, '📋');
        if (!isGroup) {
          await sock.sendMessage(jid, { text: 'ℹ️ Cette commande fonctionne uniquement dans un groupe.' });
          continue;
        }
        await handleCheckWarningsCommand(sock, jid, messageText, senderId, msg, groupData);
        continue;
      }

      // Commande .warn (Admins / Sudo)
      if (startsWithCmd('warn ') || isCmd('warn')) {
        if (!senderIsAdmin && !senderIsSudo) {
          reactToMessage(sock, jid, msg.key, '🔒');
          continue;
        }
        reactToMessage(sock, jid, msg.key, '⚠️');
        if (!isGroup) {
          await sock.sendMessage(jid, { text: 'ℹ️ Cette commande fonctionne uniquement dans un groupe.' });
          continue;
        }
        await handleWarnCommand(sock, jid, messageText, groupData, msg);
        continue;
      }

      // Commande .resetwarn (Admins / Sudo)
      if (startsWithCmd('resetwarn') || isCmd('resetwarn')) {
        if (!senderIsAdmin && !senderIsSudo) {
          reactToMessage(sock, jid, msg.key, '🔒');
          continue;
        }
        reactToMessage(sock, jid, msg.key, '🔄');
        if (!isGroup) {
          await sock.sendMessage(jid, { text: 'ℹ️ Cette commande fonctionne uniquement dans un groupe.' });
          continue;
        }
        await handleResetWarnCommand(sock, jid, messageText, groupData, msg);
        continue;
      }

      // Commande .kicking [on/off] (Strictement réservé au Bot Owner)
      if (startsWithCmd('kicking') || isCmd('kicking')) {
        if (!isOwner) {
          reactToMessage(sock, jid, msg.key, '🔒');
          continue;
        }
        reactToMessage(sock, jid, msg.key, '⚙️');
        await handleKickingToggleCommand(sock, jid, messageText, msg);
        continue;
      }

      // Commande .kick (Admins / Sudo)
      if (startsWithCmd('kick') || isCmd('kick')) {
        if (!senderIsAdmin && !senderIsSudo) {
          reactToMessage(sock, jid, msg.key, '🔒');
          continue;
        }
        if (!isKickingEnabled()) {
          reactToMessage(sock, jid, msg.key, '🔒');
          await sock.sendMessage(jid, { 
            text: '❌ *خاصية الطرد (.kick) معطلة حالياً*.\nلا يمكن استخدام أمر الطرد إلا بعد تفعيلها من طرف مالك البوت عبر الأمر: *.kicking on*' 
          }, { quoted: msg });
          continue;
        }
        reactToMessage(sock, jid, msg.key, '🚪');
        if (!isGroup) {
          await sock.sendMessage(jid, { text: 'ℹ️ هذه العملية تعمل فقط داخل المجموعات.' });
          continue;
        }
        await handleManualKickCommand(sock, jid, messageText, groupData, msg, senderIsSudo, isOwner);
        continue;
      }

      // Commande secrète .ban (Sudo / Owner exclusif - non répertoriée dans les menus)
      if (startsWithCmd('ban') || isCmd('ban')) {
        if (!senderIsSudo) {
          reactToMessage(sock, jid, msg.key, '🔒');
          continue;
        }
        reactToMessage(sock, jid, msg.key, '⛔');
        await handleBanCommand(sock, jid, messageText, msg, senderIsSudo);
        continue;
      }

      // Commande secrète .unban (Sudo / Owner exclusif - non répertoriée dans les menus)
      if (startsWithCmd('unban') || isCmd('unban')) {
        if (!senderIsSudo) {
          reactToMessage(sock, jid, msg.key, '🔒');
          continue;
        }
        reactToMessage(sock, jid, msg.key, '🔓');
        await handleUnbanCommand(sock, jid, messageText, msg, senderIsSudo);
        continue;
      }

      // Commande .blacklist / .banlist (Sudo / Owner exclusif)
      if (
        isCmd('blacklist') || isCmd('banlist') || isCmd('blacklisted') || isCmd('banned') ||
        startsWithCmd('blacklist') || startsWithCmd('banlist') || startsWithCmd('blacklisted') || startsWithCmd('banned')
      ) {
        if (!senderIsSudo) {
          reactToMessage(sock, jid, msg.key, '🔒');
          continue;
        }
        reactToMessage(sock, jid, msg.key, '📋');
        await handleBlacklistCommand(sock, jid, msg);
        continue;
      }

      // Commande .mode [public/private] (Sudo / Owner)
      if (startsWithCmd('mode') || isCmd('mode')) {
        if (!senderIsSudo) {
          reactToMessage(sock, jid, msg.key, '🔒');
          continue;
        }
        reactToMessage(sock, jid, msg.key, '⚙️');
        await handleModeCommand(sock, jid, messageText, senderIsSudo);
        continue;
      }

      // Commande .sudolist / .sudos / .sudo (Affichage de la liste des Sudo)
      const isSudoListRequest = isCmd('sudolist') || isCmd('sudos') ||
        (isCmd('sudo') && !extractTargetUser(messageText, msg));

      if (isSudoListRequest) {
        if (!senderIsSudo) {
          reactToMessage(sock, jid, msg.key, '🔒');
          continue;
        }
        reactToMessage(sock, jid, msg.key, '👑');
        await handleSudoListCommand(sock, jid);
        continue;
      }

      // Commande .addsudo @user / .sudo @user (Ajouter un Sudo)
      if (startsWithCmd('addsudo') || (startsWithCmd('sudo') && extractTargetUser(messageText, msg))) {
        if (!senderIsSudo) {
          reactToMessage(sock, jid, msg.key, '🔒');
          continue;
        }
        reactToMessage(sock, jid, msg.key, '🛡️');
        await handleAddSudoCommand(sock, jid, messageText, msg, senderIsSudo);
        continue;
      }

      // Commande .delsudo @user (Sudo / Owner)
      if (startsWithCmd('delsudo') || startsWithCmd('removesudo') || isCmd('delsudo') || isCmd('removesudo')) {
        if (!senderIsSudo) {
          reactToMessage(sock, jid, msg.key, '🔒');
          continue;
        }
        reactToMessage(sock, jid, msg.key, '🗑️');
        await handleRemoveSudoCommand(sock, jid, messageText, msg, senderIsSudo);
        continue;
      }

      // Commande .promote @user (Group Admins / Sudo)
      if (startsWithCmd('promote') || isCmd('promote')) {
        if (!senderIsAdmin && !senderIsSudo) {
          reactToMessage(sock, jid, msg.key, '🔒');
          continue;
        }
        reactToMessage(sock, jid, msg.key, '🎖️');
        if (!isGroup) {
          await sock.sendMessage(jid, { text: 'ℹ️ هذه العملية تعمل فقط داخل المجموعات.' });
          continue;
        }
        await handlePromoteCommand(sock, jid, messageText, msg, groupData);
        continue;
      }

      // Commande .demoteall (Strictement réservé au compte bot lui-même)
      if (isCmd('demoteall') || startsWithCmd('demoteall')) {
        if (!isFromMe) {
          reactToMessage(sock, jid, msg.key, '🔒');
          continue;
        }
        reactToMessage(sock, jid, msg.key, '🧹');
        if (!isGroup) {
          await sock.sendMessage(jid, { text: 'ℹ️ هذه العملية تعمل فقط داخل المجموعات.' });
          continue;
        }
        await handleDemoteAllCommand(sock, jid, groupData);
        continue;
      }

      // Commande .demote @user (Group Admins / Sudo)
      if ((startsWithCmd('demote') && !startsWithCmd('demoteall')) || isCmd('demote')) {
        if (!senderIsAdmin && !senderIsSudo) {
          reactToMessage(sock, jid, msg.key, '🔒');
          continue;
        }
        reactToMessage(sock, jid, msg.key, '⬇️');
        if (!isGroup) {
          await sock.sendMessage(jid, { text: 'ℹ️ هذه العملية تعمل فقط داخل المجموعات.' });
          continue;
        }
        await handleDemoteCommand(sock, jid, messageText, msg, groupData);
        continue;
      }

      // Commande .antispamadd [on/off] (Group Admins / Sudo)
      if (startsWithCmd('antispamadd') || isCmd('antispamadd')) {
        if (!senderIsAdmin && !senderIsSudo) {
          reactToMessage(sock, jid, msg.key, '🔒');
          continue;
        }
        reactToMessage(sock, jid, msg.key, '🛡️');
        if (!isGroup) {
          await sock.sendMessage(jid, { text: 'ℹ️ هذه العملية تعمل فقط داخل المجموعات.' });
          continue;
        }
        await handleAntiSpamAddToggleCommand(sock, jid, messageText, senderIsAdmin, senderIsSudo);
        continue;
      }

      // Commande .antibot [on/off] (Group Admins / Sudo)
      if (startsWithCmd('antibot') || isCmd('antibot')) {
        if (!senderIsAdmin && !senderIsSudo) {
          reactToMessage(sock, jid, msg.key, '🔒');
          continue;
        }
        reactToMessage(sock, jid, msg.key, '🤖');
        if (!isGroup) {
          await sock.sendMessage(jid, { text: 'ℹ️ هذه العملية تعمل فقط داخل المجموعات.' });
          continue;
        }
        await handleAntiBotToggleCommand(sock, jid, messageText, senderIsAdmin, senderIsSudo);
        continue;
      }

      // Commande .antispam [on/off] (Group Admins / Sudo)
      if (startsWithCmd('antispam') || isCmd('antispam')) {
        if (!senderIsAdmin && !senderIsSudo) {
          reactToMessage(sock, jid, msg.key, '🔒');
          continue;
        }
        reactToMessage(sock, jid, msg.key, '🚨');
        if (!isGroup) {
          await sock.sendMessage(jid, { text: 'ℹ️ هذه العملية تعمل فقط داخل المجموعات.' });
          continue;
        }
        await handleAntiSpamToggleCommand(sock, jid, messageText, senderIsAdmin, senderIsSudo);
        continue;
      }

      // Commande .scan (Group Admins / Sudo)
      if (isCmd('scan') || startsWithCmd('scan')) {
        if (!senderIsAdmin && !senderIsSudo) {
          reactToMessage(sock, jid, msg.key, '🔒');
          continue;
        }
        reactToMessage(sock, jid, msg.key, '🔍');
        if (!isGroup) {
          await sock.sendMessage(jid, { text: 'ℹ️ هذه العملية تعمل فقط داخل المجموعات.' });
          continue;
        }
        await handleScanCommand(sock, jid, groupData, senderIsAdmin, senderIsSudo);
        continue;
      }

      // Commande .antilink [on/off] (Group Admins / Sudo)
      if (startsWithCmd('antilink') || isCmd('antilink')) {
        if (!senderIsAdmin && !senderIsSudo) {
          reactToMessage(sock, jid, msg.key, '🔒');
          continue;
        }
        reactToMessage(sock, jid, msg.key, '🛡️');
        if (!isGroup) {
          await sock.sendMessage(jid, { text: 'ℹ️ هذه العملية تعمل فقط داخل المجموعات.' });
          continue;
        }
        await handleAntiLinkToggleCommand(sock, jid, messageText, senderIsAdmin, senderIsSudo);
        continue;
      }

      // Commande .allowlink / .allowlinks @user (Group Admins / Sudo)
      if (startsWithCmd('allowlink') || startsWithCmd('allowlinks') || isCmd('allowlink')) {
        if (!senderIsAdmin && !senderIsSudo) {
          reactToMessage(sock, jid, msg.key, '🔒');
          continue;
        }
        reactToMessage(sock, jid, msg.key, '🔗');
        if (!isGroup) {
          await sock.sendMessage(jid, { text: 'ℹ️ هذه العملية تعمل فقط داخل المجموعات.' });
          continue;
        }
        await handleAllowLinkCommand(sock, jid, messageText, msg, senderIsAdmin, senderIsSudo);
        continue;
      }

      // Commande .disallowlink / .dellink @user (Group Admins / Sudo)
      if (startsWithCmd('disallowlink') || startsWithCmd('dellink') || isCmd('disallowlink') || isCmd('dellink')) {
        if (!senderIsAdmin && !senderIsSudo) {
          reactToMessage(sock, jid, msg.key, '🔒');
          continue;
        }
        reactToMessage(sock, jid, msg.key, '🚫');
        if (!isGroup) {
          await sock.sendMessage(jid, { text: 'ℹ️ هذه العملية تعمل فقط داخل المجموعات.' });
          continue;
        }
        await handleDisallowLinkCommand(sock, jid, messageText, msg, senderIsAdmin, senderIsSudo);
        continue;
      }

      // Commande .allowedlinks / .allowlinklist (Group Admins / Sudo / All)
      if (isCmd('allowedlinks') || isCmd('allowlinklist')) {
        reactToMessage(sock, jid, msg.key, '📋');
        if (!isGroup) {
          await sock.sendMessage(jid, { text: 'ℹ️ هذه العملية تعمل فقط داخل المجموعات.' });
          continue;
        }
        await handleAllowedLinksListCommand(sock, jid);
        continue;
      }

      // Commande .allowbot / .allowbots @user / number (Group Admins / Sudo)
      if (startsWithCmd('allowbot') || startsWithCmd('allowbots') || isCmd('allowbot')) {
        if (!senderIsAdmin && !senderIsSudo) {
          reactToMessage(sock, jid, msg.key, '🔒');
          continue;
        }
        reactToMessage(sock, jid, msg.key, '🛡️');
        if (!isGroup) {
          await sock.sendMessage(jid, { text: 'ℹ️ هذه العملية تعمل فقط داخل المجموعات.' });
          continue;
        }
        await handleAllowBotCommand(sock, jid, messageText, msg, senderIsAdmin, senderIsSudo);
        continue;
      }

      // Commande .disallowbot / .delbot @user / number (Group Admins / Sudo)
      if (startsWithCmd('disallowbot') || startsWithCmd('delbot') || isCmd('disallowbot') || isCmd('delbot')) {
        if (!senderIsAdmin && !senderIsSudo) {
          reactToMessage(sock, jid, msg.key, '🔒');
          continue;
        }
        reactToMessage(sock, jid, msg.key, '🚫');
        if (!isGroup) {
          await sock.sendMessage(jid, { text: 'ℹ️ هذه العملية تعمل فقط داخل المجموعات.' });
          continue;
        }
        await handleDisallowBotCommand(sock, jid, messageText, msg, senderIsAdmin, senderIsSudo);
        continue;
      }

      // Commande .allowedbots / .botwhitelist (Group Admins / Sudo)
      if (isCmd('allowedbots') || isCmd('botwhitelist') || startsWithCmd('allowedbots') || startsWithCmd('botwhitelist')) {
        if (!senderIsAdmin && !senderIsSudo) {
          reactToMessage(sock, jid, msg.key, '🔒');
          continue;
        }
        reactToMessage(sock, jid, msg.key, '📋');
        if (!isGroup) {
          await sock.sendMessage(jid, { text: 'ℹ️ هذه العملية تعمل فقط داخل المجموعات.' });
          continue;
        }
        await handleAllowedBotsListCommand(sock, jid, senderIsAdmin, senderIsSudo);
        continue;
      }

      // Commande .allow / .allowuser @user (Sudo / Group Admins)
      if (startsWithCmd('allowuser') || startsWithCmd('allow') || isCmd('allowuser') || isCmd('allow')) {
        if (!cleanCmdText.startsWith('allowbot') && !cleanCmdText.startsWith('allowlink') && !cleanCmdText.startsWith('allowbots') && !cleanCmdText.startsWith('allowlinks')) {
          if (!senderIsAdmin && !senderIsSudo) {
            reactToMessage(sock, jid, msg.key, '🔒');
            continue;
          }
          reactToMessage(sock, jid, msg.key, '👤');
          if (!isGroup) {
            await sock.sendMessage(jid, { text: 'ℹ️ هذه العملية تعمل فقط داخل المجموعات.' });
            continue;
          }
          await handleAllowUserCommand(sock, jid, messageText, msg, senderIsAdmin, senderIsSudo);
          continue;
        }
      }

      // Commande .disallow / .deluser @user (Sudo / Group Admins)
      if (startsWithCmd('disallowuser') || startsWithCmd('disallow') || startsWithCmd('deluser') || isCmd('disallowuser') || isCmd('disallow') || isCmd('deluser')) {
        if (!cleanCmdText.startsWith('disallowbot') && !cleanCmdText.startsWith('disallowlink') && !cleanCmdText.startsWith('delbot')) {
          if (!senderIsAdmin && !senderIsSudo) {
            reactToMessage(sock, jid, msg.key, '🔒');
            continue;
          }
          reactToMessage(sock, jid, msg.key, '🚫');
          if (!isGroup) {
            await sock.sendMessage(jid, { text: 'ℹ️ هذه العملية تعمل فقط داخل المجموعات.' });
            continue;
          }
          await handleDisallowUserCommand(sock, jid, messageText, msg, senderIsAdmin, senderIsSudo);
          continue;
        }
      }

      // Commande .allowedusers / .users (Sudo / Group Admins)
      if (isCmd('allowedusers') || isCmd('users') || startsWithCmd('allowedusers')) {
        if (!senderIsAdmin && !senderIsSudo) {
          reactToMessage(sock, jid, msg.key, '🔒');
          continue;
        }
        reactToMessage(sock, jid, msg.key, '📋');
        if (!isGroup) {
          await sock.sendMessage(jid, { text: 'ℹ️ هذه العملية تعمل فقط داخل المجموعات.' });
          continue;
        }
        await handleAllowedUsersListCommand(sock, jid, senderIsAdmin, senderIsSudo);
        continue;
      }

      // Commande .trust @user / number (Group Admins / Sudo)
      if (startsWithCmd('trust') || startsWithCmd('trustbot') || isCmd('trust')) {
        if (!senderIsAdmin && !senderIsSudo) {
          reactToMessage(sock, jid, msg.key, '🔒');
          continue;
        }
        reactToMessage(sock, jid, msg.key, '🌟');
        if (!isGroup) {
          await sock.sendMessage(jid, { text: 'ℹ️ هذه العملية تعمل فقط داخل المجموعات.' });
          continue;
        }
        await handleTrustCommand(sock, jid, messageText, msg, senderIsAdmin, senderIsSudo);
        continue;
      }

      // Commande .untrust / .deltrust @user / number (Group Admins / Sudo)
      if (startsWithCmd('untrust') || isCmd('untrust')) {
        if (!senderIsAdmin && !senderIsSudo) {
          reactToMessage(sock, jid, msg.key, '🔒');
          continue;
        }
        reactToMessage(sock, jid, msg.key, '🚫');
        if (!isGroup) {
          await sock.sendMessage(jid, { text: 'ℹ️ هذه العملية تعمل فقط داخل المجموعات.' });
          continue;
        }
        await handleUntrustCommand(sock, jid, messageText, msg, senderIsAdmin, senderIsSudo);
        continue;
      }

      // Commande .trustlist / .trusted (Group Admins / Sudo / All)
      if (isCmd('trustlist') || isCmd('trusted')) {
        reactToMessage(sock, jid, msg.key, '🌟');
        await handleTrustListCommand(sock, jid);
        continue;
      }

      // Commande .requests (Group Admins / Sudo)
      if (isCmd('requests')) {
        if (!senderIsAdmin && !senderIsSudo) {
          reactToMessage(sock, jid, msg.key, '🔒');
          continue;
        }
        reactToMessage(sock, jid, msg.key, '📥');
        if (!isGroup) {
          await sock.sendMessage(jid, { text: 'ℹ️ هذه العملية تعمل فقط داخل المجموعات.' });
          continue;
        }
        await handleJoinRequestsListCommand(sock, jid, senderIsAdmin, senderIsSudo);
        continue;
      }

      // Commande .accept [number/index] (Group Admins / Sudo)
      if (startsWithCmd('accept') || isCmd('accept')) {
        if (!senderIsAdmin && !senderIsSudo) {
          reactToMessage(sock, jid, msg.key, '🔒');
          continue;
        }
        reactToMessage(sock, jid, msg.key, '✅');
        if (!isGroup) {
          await sock.sendMessage(jid, { text: 'ℹ️ هذه العملية تعمل فقط داخل المجموعات.' });
          continue;
        }
        await handleJoinRequestActionCommand(sock, jid, messageText, 'accept', senderIsAdmin, senderIsSudo);
        continue;
      }

      // Commande .reject [number/index] (Group Admins / Sudo)
      if (startsWithCmd('reject') || isCmd('reject')) {
        if (!senderIsAdmin && !senderIsSudo) {
          reactToMessage(sock, jid, msg.key, '🔒');
          continue;
        }
        reactToMessage(sock, jid, msg.key, '❌');
        if (!isGroup) {
          await sock.sendMessage(jid, { text: 'ℹ️ هذه العملية تعمل فقط داخل المجموعات.' });
          continue;
        }
        await handleJoinRequestActionCommand(sock, jid, messageText, 'reject', senderIsAdmin, senderIsSudo);
        continue;
      }

      // Commande .reset / .revoke (Group Admins / Sudo)
      if (isCmd('reset') || isCmd('revoke') || startsWithCmd('reset') || startsWithCmd('revoke')) {
        if (!senderIsAdmin && !senderIsSudo) {
          reactToMessage(sock, jid, msg.key, '🔒');
          continue;
        }
        reactToMessage(sock, jid, msg.key, '🔄');
        if (!isGroup) {
          await sock.sendMessage(jid, { text: 'ℹ️ هذه العملية تعمل فقط داخل المجموعات.' });
          continue;
        }
        await handleResetInviteLinkCommand(sock, jid, senderIsAdmin, senderIsSudo);
        continue;
      }

      // Commande .close / .lock (Group Admins / Sudo)
      if (isCmd('close') || isCmd('lock') || startsWithCmd('close') || startsWithCmd('lock')) {
        if (!senderIsAdmin && !senderIsSudo) {
          reactToMessage(sock, jid, msg.key, '🔒');
          continue;
        }
        reactToMessage(sock, jid, msg.key, '🔒');
        if (!isGroup) {
          await sock.sendMessage(jid, { text: 'ℹ️ هذه العملية تعمل فقط داخل المجموعات.' });
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

      // Commande .open / .unlock (Group Admins / Sudo)
      if (isCmd('open') || isCmd('unlock') || startsWithCmd('open') || startsWithCmd('unlock')) {
        if (!senderIsAdmin && !senderIsSudo) {
          reactToMessage(sock, jid, msg.key, '🔒');
          continue;
        }
        reactToMessage(sock, jid, msg.key, '🔓');
        if (!isGroup) {
          await sock.sendMessage(jid, { text: 'ℹ️ هذه العملية تعمل فقط داخل المجموعات.' });
          continue;
        }
        try {
          await sock.groupSettingUpdate(jid, 'not_announcement');
          await sock.sendMessage(jid, { text: '🔓 *تـم فـتـح الـمـجـمـوعـة (الـجـمـيـع يـمـكـنـهـم الإرسـال الآن)*' });
        } catch (openErr) {
          await sock.sendMessage(jid, { text: `❌ تعذر فتح المجموعة: ${openErr.message}` });
        }
        continue;
        if (!senderIsAdmin && !senderIsSudo) {
          reactToMessage(sock, jid, msg.key, '🔒');
          continue;
        }
        reactToMessage(sock, jid, msg.key, '🔓');
        if (!isGroup) {
          await sock.sendMessage(jid, { text: 'ℹ️ هذه العملية تعمل فقط داخل المجموعات.' });
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
      // "si quelqu un utilise . avec commnde qui n existe pas ile repond avec (هدشي واللهم كين)"
      if (isPrefixCommand && trimmedText.length > 1 && !trimmedText.startsWith('..') && !trimmedText.startsWith('...')) {
        reactToMessage(sock, jid, msg.key, '❓');
        await sock.sendMessage(jid, { 
          text: 'هدشي واللهم كين' 
        }, { quoted: msg });
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
 * Vérifier si un identifiant ou numéro correspond au compte bot lui-même
 * (Protection absolue contre l'auto-bannissement / auto-blocage / auto-expulsion)
 */
function isSelfUser(sock, targetJid) {
  if (!sock || !sock.user || !targetJid) return false;
  const botId = sock.user.id || '';
  const botLid = sock.user.lid || '';
  const botPhone = botId.split('@')[0].split(':')[0];
  const targetClean = String(targetJid).split('@')[0].split(':')[0].replace(/[^0-9]/g, '');

  if (botPhone && targetClean === botPhone) return true;
  if (botId && (targetJid === botId || targetClean === botId.split('@')[0].split(':')[0])) return true;
  if (botLid && (targetJid === botLid || targetClean === botLid.split('@')[0].split(':')[0])) return true;
  return false;
}

// Protection stricte anti-ban sur le blocage WhatsApp
const lastBlockTimestamps = new Map(); // botPhone -> timestamp

/**
 * Bloquer un utilisateur en toute sécurité avec protection anti-ban
 * (WhatsApp bannit immédiatement les numéros de bot qui bloquent fréquemment)
 */
async function safeBlockUser(sock, targetJid) {
  try {
    if (!sock || !targetJid) return;
    if (isSelfUser(sock, targetJid) || isSudo(targetJid)) {
      logActivity(`[Anti-Ban] Tentative de blocage ignorée pour compte protégé (bot/sudo): ${targetJid}`, 'warn');
      return;
    }
    const botPhone = (sock.user?.id || '').split('@')[0].split(':')[0];
    const now = Date.now();
    const lastBlock = lastBlockTimestamps.get(botPhone) || 0;
    // Cooldown strict de 10 minutes entre chaque opération de blocage pour protéger le numéro
    if (now - lastBlock < 10 * 60 * 1000) {
      logActivity(`[Anti-Ban] Blocage de ${targetJid} différé pour protéger le numéro du bot (cooldown actif).`);
      return;
    }
    lastBlockTimestamps.set(botPhone, now);
    await sock.updateBlockStatus(targetJid, 'block');
    logActivity(`[Anti-Ban] Utilisateur ${targetJid} bloqué sur WhatsApp.`);
  } catch (err) {
    logActivity(`[Anti-Ban] Échec blocage ${targetJid}: ${err.message}`, 'warn');
  }
}

/**
 * Expulser des participants en toute sécurité en garantissant que le bot ne s'expulse jamais lui-même,
 * ne touche jamais aux sudos, rétrograde les admins avant de les expulser, et applique une temporisation
 * anti-mass-kick pour éviter que WhatsApp ne bannisse le numéro du bot.
 */
async function safeGroupParticipantsRemove(sock, jid, participantsList) {
  if (!sock || !jid || !Array.isArray(participantsList)) return;
  const safeList = participantsList.filter(p => !isSelfUser(sock, p) && !isSudo(p));
  if (safeList.length === 0) return;

  // 1. Tenter de rétrograder automatiquement les admins avant l'expulsion
  try {
    let groupData = groupMetadataCache.get(cleanGroupId(jid))?.data;
    if (!groupData || !groupData.participants) {
      groupData = await getGroupDataSafely(sock, jid);
    }
    if (groupData?.participants) {
      for (const target of safeList) {
        const cleanT = String(target).split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
        const p = groupData.participants.find(part => {
          const pClean = (part.id || part.jid || '').split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
          return pClean === cleanT;
        });
        if (p && (p.admin === 'admin' || p.admin === 'superadmin')) {
          const demoteTarget = p.id || p.jid || target;
          await sock.groupParticipantsUpdate(jid, [demoteTarget], 'demote').catch(() => {});
          await new Promise(r => setTimeout(r, 800));
        }
      }
    }
  } catch (_) {}

  // 2. Exécuter l'expulsion avec temporisation anti-ban individuelle
  for (let i = 0; i < safeList.length; i++) {
    const t = safeList[i];
    try {
      await sock.groupParticipantsUpdate(jid, [t], 'remove');
    } catch (indErr) {
      const clean = String(t).split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
      if (clean && !t.endsWith('@s.whatsapp.net')) {
        await sock.groupParticipantsUpdate(jid, [`${clean}@s.whatsapp.net`], 'remove').catch(() => {});
      }
    }
    // Pause anti-ban de 1.2s à 1.8s entre chaque expulsion successive pour éviter le flag de mass-kick
    if (i < safeList.length - 1) {
      await new Promise(r => setTimeout(r, Math.floor(Math.random() * 600) + 1200));
    }
  }
}

/**
 * Vérifie et purge immédiatement tout membre de la liste noire présent dans un groupe donné.
 * - Si le bot est ADMIN : Rétrograde si le membre est admin, publie le message, expulse et bloque immédiatement.
 * - Si le bot N'EST PAS ADMIN : Tague tous les admins du groupe avec une alerte rouge urgente, publie le message et bloque.
 */
async function checkAndPurgeBlacklistInGroup(sock, jid, initialGroupData = null) {
  try {
    if (!sock || !jid || !jid.endsWith('@g.us')) return;

    let groupData = initialGroupData;
    if (!groupData || !groupData.participants || groupData.participants.length === 0) {
      groupData = await getGroupDataSafely(sock, jid);
    }
    if (!groupData || !groupData.participants || groupData.participants.length === 0) return;

    const participants = groupData.participants;
    const botId = sock.user?.id || '';
    const botNumber = botId.split('@')[0].split(':')[0];
    const botIsAdmin = isAdmin(botId, groupData);

    const blacklistedFound = [];

    for (const p of participants) {
      let cleanPhone = null;
      const rawJid = p.id || p.jid || '';

      if (p.jid && p.jid.endsWith('@s.whatsapp.net')) {
        cleanPhone = p.jid.split('@')[0].split(':')[0];
      } else if (p.id && p.id.endsWith('@s.whatsapp.net')) {
        cleanPhone = p.id.split('@')[0].split(':')[0];
      } else if (p.phoneNumber) {
        cleanPhone = String(p.phoneNumber).replace(/[^0-9]/g, '');
      } else {
        cleanPhone = resolveRealPhoneNumber(rawJid);
      }

      if ((!cleanPhone || cleanPhone.length > 15 || rawJid.endsWith('@lid')) && typeof resolveLidToPhoneViaUSync === 'function') {
        const usyncPhone = await resolveLidToPhoneViaUSync(sock, rawJid);
        if (usyncPhone) cleanPhone = usyncPhone;
      }

      if (!cleanPhone) {
        cleanPhone = rawJid.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
      }

      if (!cleanPhone || cleanPhone === botNumber || isSelfUser(sock, cleanPhone)) continue;
      if (isSudo(cleanPhone) || isPermanentWhitelisted(cleanPhone)) continue;

      const isBl = isBannedUser(cleanPhone) || isBannedUser(rawJid) || isNumberBlacklisted(cleanPhone) || isNumberBlacklisted(rawJid);
      if (isBl) {
        blacklistedFound.push({
          participant: p,
          rawJid: rawJid || `${cleanPhone}@s.whatsapp.net`,
          phone: cleanPhone,
          isAdmin: p.admin === 'admin' || p.admin === 'superadmin'
        });
      }
    }

    if (blacklistedFound.length === 0) return;

    logActivity(`[BlacklistRadar] ${blacklistedFound.length} membre(s) blacklisté(s) détecté(s) dans ${jid} (Bot Admin: ${botIsAdmin ? 'OUI' : 'NON'})`, 'warn');

    if (botIsAdmin) {
      // 1. LE BOT EST ADMIN : Rétrogradation si admin, message, expulsion immédiate et blocage
      for (const item of blacklistedFound) {
        if (item.isAdmin) {
          logActivity(`[BlacklistRadar] Rétrogradation de l'admin blacklisté @${item.phone} dans ${jid}...`, 'warn');
          await sock.groupParticipantsUpdate(jid, [item.rawJid], 'demote').catch((err) => {
            logActivity(`[BlacklistRadar] Échec rétrogradation @${item.phone}: ${err.message}`, 'warn');
          });
          await new Promise((r) => setTimeout(r, 400));
        }

        await sock.sendMessage(jid, {
          text: 'هههههه مبند هبط تشم الصبابط',
          mentions: [item.rawJid, `${item.phone}@s.whatsapp.net`].filter(Boolean)
        }).catch(() => {});

        await safeGroupParticipantsRemove(sock, jid, [item.rawJid]).catch((err) => {
          logActivity(`[BlacklistRadar] Échec expulsion @${item.phone}: ${err.message}`, 'warn');
        });
        logActivity(`[BlacklistRadar] Membre blacklisté @${item.phone} expulsé avec succès de ${jid}!`);
      }
    } else {
      // 2. LE BOT N'EST PAS ADMIN : Alerter tous les administrateurs du groupe en les taguant
      const now = Date.now();
      const adminParticipants = participants.filter(
        (a) => (a.admin === 'admin' || a.admin === 'superadmin') && !a.id?.includes(botNumber) && !a.jid?.includes(botNumber)
      );
      const adminMentions = adminParticipants.map((a) => a.id || a.jid).filter(Boolean);
      const adminTags = adminMentions.map((id) => `@${id.split('@')[0].split(':')[0]}`).join(' ');

      for (const item of blacklistedFound) {
        const alertKey = `${jid}:${item.phone}`;
        const lastAlert = blacklistAdminAlertCooldown.get(alertKey) || 0;
        // Alerter au max une fois toutes les 3 minutes par numéro dans ce groupe
        if (now - lastAlert < 180000) continue;
        blacklistAdminAlertCooldown.set(alertKey, now);

        let alertMsg = `⎔⋅• ━ ╼━ ╼╃ ⌬〔 🚨 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
        alertMsg += `       🏰 *إمـبـراطـوريـة بـاراديـس* 🏰\n`;
        alertMsg += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 🚨 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n\n`;
        alertMsg += `⚠️ *تـحـذيـر أمـنـي عـاجـل - عـضـو مـحـظـور بـالـقـائـمـة الـسـوداء* ⚠️\n\n`;
        alertMsg += `🚨 تـم رصـد حـسـاب مـن الـقـائـمـة الـسـوداء (Blacklist) داخـل الـمـجـمـوعـة:\n`;
        alertMsg += `⛔ الـعـضـو : @${item.phone} (+${item.phone})${item.isAdmin ? ' 👑 *(مـشـرف ⚠️)*' : ''}\n\n`;
        alertMsg += `📢 *نـداء عـاجـل لـكـافـة مـشـرفـي الـمـجـمـوعـة* :\n`;
        alertMsg += `⋄ الـبـوت لـيـس مـشـرفـاً (Admin) لـيـقـوم بـطـرده تـلـقـائـيـاً!\n`;
        alertMsg += `⋄ يُـرجـى ${item.isAdmin ? 'سـحـب الإشـراف مـنـه و' : ''}طـرده فـوراً لـحـمـايـة الـمـجـمـوعـة 👢:\n`;
        if (adminTags) {
          alertMsg += `${adminTags}\n\n`;
        }
        alertMsg += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚔️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
        alertMsg += `       🏰 *PARADIS EMPIRE DEFENSE* 🏰`;

        await sock.sendMessage(jid, {
          text: alertMsg,
          mentions: [...adminMentions, item.rawJid, `${item.phone}@s.whatsapp.net`].filter(Boolean)
        }).catch(() => {});

        await sock.sendMessage(jid, {
          text: 'هههههه مبند هبط تشم الصبابط',
          mentions: [item.rawJid, `${item.phone}@s.whatsapp.net`].filter(Boolean)
        }).catch(() => {});
      }
    }
  } catch (err) {
    logActivity(`[BlacklistPurge] Erreur vérification groupe ${jid}: ${err.message}`, 'warn');
  }
}

/**
 * Purge la liste noire sur TOUS les groupes où le bot est présent
 */
async function purgeBlacklistFromAllGroups(sock) {
  try {
    if (!sock) return;
    let groups = [];
    if (typeof sock.groupFetchAllParticipating === 'function') {
      const participating = await sock.groupFetchAllParticipating().catch(() => ({}));
      groups = Object.values(participating || {});
    }
    if (groups.length === 0) return;

    for (const group of groups) {
      if (!group?.id) continue;
      await checkAndPurgeBlacklistInGroup(sock, group.id, group);
    }
  } catch (err) {
    logActivity(`[BlacklistPurge] Erreur purge générale: ${err.message}`, 'warn');
  }
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
      currentGroupData = await getGroupDataSafely(sock, jid);
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

    // 3. Expulser l'utilisateur directement sans avertissement (Kick direct)
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
      currentGroupData = await getGroupDataSafely(sock, jid);
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

    // Protection compte bot et sudo (ne jamais bloquer ou kicker soi-même)
    if (isSelfUser(sock, senderId) || isSudo(senderId)) return;

    logActivity(`[Anti-Ban] Tentative d'exécution de commande interdite (.ban/exploit) par @${senderNumber} dans ${jid}`, 'warn');

    // 1. Supprimer le message
    try {
      if (msg && msg.key) {
        await sock.sendMessage(jid, { delete: msg.key });
      }
    } catch (_) {}

    if (!isGroup) {
      await safeBlockUser(sock, senderId);
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

    // 4. Récupérer les admins pour mention
    let currentGroupData = groupData;
    if (!currentGroupData || !currentGroupData.participants) {
      currentGroupData = await getGroupDataSafely(sock, jid);
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

    // Expulser du groupe (Kick sécurisé)
    try {
      await safeGroupParticipantsRemove(sock, jid, [resolved.participant?.id || senderId]);
      logActivity(`[Anti-Ban] Utilisateur ${resolved.tag} expulsé du groupe.`);
    } catch (kickErr) {
      logActivity(`[Anti-Ban] Erreur expulsion ${resolved.tag}: ${kickErr.message}`, 'warn');
    }

    // Bloquer l'attaquant sur WhatsApp (Block sécurisé)
    await safeBlockUser(sock, senderId);

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
 * Module de Défense et Protection des membres Sudo
 * Empêche qu'un admin de groupe non-sudo puisse exclure ou rétrograder un membre de la Sudo List.
 * Seul un membre de la Sudo List peut kicker ou rétrograder un membre Sudo.
 */
async function handleSudoDefense(botPhone, sock, update) {
  try {
    const { id: jid, participants, action, author } = update;
    if (!jid || !participants || participants.length === 0) return;
    if (action !== 'remove' && action !== 'demote') return;

    const botNumber = (sock.user?.id || '').split('@')[0].split(':')[0];
    let authorPhone = resolveRealPhoneNumber(author);

    if (!authorPhone || authorPhone.length > 14 || (author && String(author).endsWith('@lid'))) {
      let gm = groupMetadataCache.get(cleanGroupId(jid))?.data;
      if (!gm) {
        try { gm = await getGroupDataSafely(sock, jid); } catch (_) {}
      }
      const foundA = gm?.participants?.find(x => x.id === author || x.lid === author || x.jid === author);
      if (foundA) {
        const rawA = foundA.jid || foundA.id || '';
        if (rawA.endsWith('@s.whatsapp.net')) authorPhone = rawA.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
        else if (foundA.phoneNumber) authorPhone = String(foundA.phoneNumber).split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
      }
      if ((!authorPhone || authorPhone.length > 14) && typeof resolveLidToPhoneViaUSync === 'function') {
        const usyncA = await resolveLidToPhoneViaUSync(sock, author);
        if (usyncA) authorPhone = usyncA;
      }
    }

    if (!authorPhone) return;
    if (authorPhone === botNumber || isSelfUser(sock, author)) return;
    // Seul un membre de la Sudo List a le droit d'exclure ou rétrograder un autre Sudo
    if (isSudo(authorPhone) || isSudo(author)) return;

    for (const p of participants) {
      let pPhone = resolveRealPhoneNumber(p);
      if (!pPhone || pPhone.length > 14 || (p && String(p).endsWith('@lid'))) {
        let gm = groupMetadataCache.get(cleanGroupId(jid))?.data;
        if (!gm) {
          try { gm = await getGroupDataSafely(sock, jid); } catch (_) {}
        }
        const foundP = gm?.participants?.find(x => x.id === p || x.lid === p || x.jid === p);
        if (foundP) {
          const rawP = foundP.jid || foundP.id || '';
          if (rawP.endsWith('@s.whatsapp.net')) pPhone = rawP.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
          else if (foundP.phoneNumber) pPhone = String(foundP.phoneNumber).split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
        }
        if ((!pPhone || pPhone.length > 14) && typeof resolveLidToPhoneViaUSync === 'function') {
          const usyncP = await resolveLidToPhoneViaUSync(sock, p);
          if (usyncP) pPhone = usyncP;
        }
      }
      if (!pPhone) pPhone = String(p).split('@')[0].split(':')[0].replace(/[^0-9]/g, '');

      // Ne pas intervenir si l'utilisateur quitte le groupe de son plein gré
      if (author && p && (author === p || authorPhone === pPhone)) continue;

      let isTargetSudo = isSudo(pPhone) || isSudo(p) || PERMANENT_SUDOS.has(pPhone);
      if (!isTargetSudo && pPhone.length >= 9) {
        const last9 = pPhone.slice(-9);
        for (const sNum of PERMANENT_SUDOS) {
          if (sNum.slice(-9) === last9) {
            isTargetSudo = true;
            pPhone = sNum;
            break;
          }
        }
      }

      if (!isTargetSudo) continue;

      logActivity(`[SudoDefense] ALERTE: L'admin @${authorPhone} a tenté de ${action} le Sudo @${pPhone} dans ${jid}!`, 'warn');

      const sudoJid = `${pPhone}@s.whatsapp.net`;
      const targetsToSanction = [author];
      if (authorPhone && !author.includes('@s.whatsapp.net')) {
        targetsToSanction.push(`${authorPhone}@s.whatsapp.net`);
      }

      if (action === 'remove') {
        // 1. Rétrograder et expulser l'attaquant non-autorisé immédiatement
        try {
          await sock.groupParticipantsUpdate(jid, targetsToSanction, 'demote').catch(() => {});
          await safeGroupParticipantsRemove(sock, jid, targetsToSanction).catch(() => {});
        } catch (e1) {
          logActivity(`[SudoDefense] Échec sanction @${authorPhone}: ${e1.message}`, 'warn');
        }

        // Remarque: Conformément aux consignes, ne pas tenter de ré-ajouter le sudo exclu

        // 2. Envoyer une alerte dans le groupe avec vrais numéros de téléphone
        let alertMsg = `⎔⋅• ━ ╼━ ╼╃ ⌬〔 🚨 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
        alertMsg += `       🏰 *إمـبـراطـوريـة بـاراديـس* 🏰\n`;
        alertMsg += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 🚨 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n\n`;
        alertMsg += `🚨 *حـمـايـة قـائـمـة الـسـوبـر أدمـيـن (SUDO DEFENSE)* 🚨\n\n`;
        alertMsg += `⚠️ *تـنـبـيـه أمـنـي* : مـحـاولـة طـرد غـيـر مـصـرح بـهـا لأحـد مـطـوري الـبـوت!\n`;
        alertMsg += `👑 *الـمـطـور الـمـسـتـهـدف* : +${pPhone} (@${pPhone})\n`;
        alertMsg += `⚔️ *الـمـعـتـدي (الـمـطـرود)* : +${authorPhone} (@${authorPhone})\n\n`;
        alertMsg += `🛡️ *إجـراءات الـدفـاع الـفـوريـة* :\n`;
        alertMsg += `⋄ تـم تـجـريـد الـمـعـتـدي مـن رتـبـة الإدارة وطـرده فـوراً مـن الـمـجـمـوعـة 👢\n\n`;
        alertMsg += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚔️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
        alertMsg += `       🏰 *PARADIS EMPIRE* 🏰`;

        const alertMentions = [sudoJid, author];
        if (authorPhone) alertMentions.push(`${authorPhone}@s.whatsapp.net`);
        await sock.sendMessage(jid, { text: alertMsg, mentions: alertMentions }).catch(() => {});
      } else if (action === 'demote') {
        await sock.groupParticipantsUpdate(jid, [p, sudoJid], 'promote').catch(() => {});
        await sock.groupParticipantsUpdate(jid, targetsToSanction, 'demote').catch(() => {});

        let alertMsg = `⎔⋅• ━ ╼━ ╼╃ ⌬〔 🚨 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
        alertMsg += `       🏰 *إمـبـراطـوريـة بـاراديـس* 🏰\n`;
        alertMsg += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 🚨 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n\n`;
        alertMsg += `🚨 *حـمـايـة قـائـمـة الـسـوبـر أدمـيـن (SUDO DEFENSE)* 🚨\n\n`;
        alertMsg += `⚠️ مـحـاولـة غـيـر مـصـرح بـهـا لـتـنـزيـل رتـبـة أحـد مـطـوري الـبـوت!\n`;
        alertMsg += `👑 *الـمـطـور الـمـسـتـهـدف* : +${pPhone} (@${pPhone})\n`;
        alertMsg += `⚔️ *الـمـعـتـدي* : +${authorPhone} (@${authorPhone})\n\n`;
        alertMsg += `🛡️ تـمـت إعـادة رتـبـة الـمـطـور فـوراً وتـجـريـد الـمـعـتـدي مـن رتـبـة الإدارة!\n\n`;
        alertMsg += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚔️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
        alertMsg += `       🏰 *PARADIS EMPIRE* 🏰`;

        const alertMentions = [sudoJid, author];
        if (authorPhone) alertMentions.push(`${authorPhone}@s.whatsapp.net`);
        await sock.sendMessage(jid, { text: alertMsg, mentions: alertMentions }).catch(() => {});
      }
    }
  } catch (err) {
    console.error('Erreur handleSudoDefense:', err);
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

    // 0. Le module Anti-Spam Add (Tabneed / Flood d'ajouts) est désactivé par défaut
    // et ne s'exécute que s'il est explicitement activé (.antispamadd on)
    if (!isAntiSpamAddEnabled(jid)) {
      return;
    }

    const botNumber = (sock.user?.id || '').split('@')[0].split(':')[0];
    const authorJid = author ? normalizeJid(author) : null;
    const authorNumber = authorJid ? authorJid.split('@')[0].split(':')[0] : null;

    // Si l'auteur est le bot lui-même ou un compte sudo ou whitelisté, ignorer totalement
    if (!authorNumber || authorNumber === botNumber || isSelfUser(sock, authorJid)) {
      return;
    }

    if (isSudo(authorJid) || isPermanentWhitelisted(authorNumber) || isPermanentWhitelisted(authorJid)) {
      return;
    }

    // Récupérer les métadonnées du groupe pour vérifier si l'auteur est admin ou propriétaire
    let groupData = null;
    try {
      groupData = await getGroupDataSafely(sock, jid);
    } catch (_) {}

    const authorParticipant = groupData?.participants?.find((p) => {
      const pNum = (p.id || p.jid || '').split('@')[0].split(':')[0];
      return pNum === authorNumber;
    });

    const isAuthorAdmin = authorParticipant?.admin === 'admin' || authorParticipant?.admin === 'superadmin';
    const isAuthorOwner = groupData?.owner && groupData.owner.split('@')[0].split(':')[0] === authorNumber;

    // RÈGLE ABSOLUE : Les administrateurs et le créateur du groupe ne doivent JAMAIS être expulsés ou bloqués
    // lorsqu'ils acceptent des demandes d'adhésion (join requests) ou ajoutent des membres !
    if (isAuthorAdmin || isAuthorOwner) {
      return;
    }

    const now = Date.now();

    // 1. Vérifier si l'un des participants ajoutés est un vecteur de تبنيد blacklisté
    let hasBlacklistedTarget = false;
    for (const p of participants) {
      let pNum = resolveRealPhoneNumber(p);
      if (!pNum) pNum = (p || '').split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
      if (BLACKLISTED_TABNEED_NUMBERS.has(pNum)) {
        hasBlacklistedTarget = true;
        break;
      }
      if (pNum && pNum.length >= 9) {
        const last9 = pNum.slice(-9);
        for (const b of BLACKLISTED_TABNEED_NUMBERS) {
          if (b.slice(-9) === last9) {
            hasBlacklistedTarget = true;
            break;
          }
        }
        if (hasBlacklistedTarget) break;
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
      await safeGroupParticipantsRemove(sock, jid, participants).catch(() => {});
      return;
    }
    addSecurityCooldown.set(trackKey, now);

    // 1. Bloquer l'attaquant sur WhatsApp (Block sécurisé)
    await safeBlockUser(sock, authorJid);

    // 2. Rétrograder l'attaquant s'il est admin
    try {
      await sock.groupParticipantsUpdate(jid, [authorJid], 'demote');
    } catch (_) {}

    // 3. Expulser l'attaquant du groupe (Kick sécurisé)
    try {
      await safeGroupParticipantsRemove(sock, jid, [authorJid]);
      logActivity(`[Anti-Tabneed] Attaquant @${authorNumber} expulsé du groupe.`);
    } catch (kickErr) {
      logActivity(`[Anti-Tabneed] Échec expulsion @${authorNumber}: ${kickErr.message}`, 'warn');
    }

    // 4. Expulser les numéros cibles ajoutés par l'attaquant (Kick sécurisé)
    try {
      await safeGroupParticipantsRemove(sock, jid, participants);
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
    try {
      if (!groupData) groupData = await getGroupDataSafely(sock, jid);
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

async function checkUserHasLinkedDevices(sock, userJid, forceFresh = false) {
  try {
    if (!userJid) return { hasLinked: false, count: 0 };
    const strJid = String(userJid);

    // 1. Résolution du vrai numéro de téléphone réel si c'est un LID
    let phone = resolveRealPhoneNumber(strJid);
    if (!phone || phone.length > 15 || strJid.endsWith('@lid')) {
      const usyncPhone = await resolveLidToPhoneViaUSync(sock, strJid);
      if (usyncPhone) phone = usyncPhone;
    }
    if (!phone) {
      phone = strJid.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
    }

    const cleanJid = `${phone}@s.whatsapp.net`;
    const now = Date.now();

    // Cache intelligent anti-ban : 15 minutes pour compte normal, 5 minutes pour compte lié
    if (!forceFresh) {
      const cached = botDeviceCheckCache.get(phone) || botDeviceCheckCache.get(cleanJid) || botDeviceCheckCache.get(strJid);
      if (cached) {
        const maxAge = cached.hasLinked ? 300000 : 900000;
        if (now - cached.timestamp < maxAge) {
          return cached;
        }
      }
    }

    if (typeof sock.getUSyncDevices !== 'function') {
      return { hasLinked: false, count: 0 };
    }

    // Interroger USync avec le format standard téléphone@s.whatsapp.net
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

    const result = { hasLinked, count, timestamp: now, phone, cleanJid };
    botDeviceCheckCache.set(phone, result);
    botDeviceCheckCache.set(cleanJid, result);
    botDeviceCheckCache.set(strJid, result);
    return result;
  } catch (err) {
    logActivity(`[AntiBot] Erreur checkUserHasLinkedDevices pour ${userJid}: ${err.message}`, 'warn');
    return { hasLinked: false, count: 0 };
  }
}

/**
 * Procédure Officielle Anti-Bot (Support d'un ou plusieurs membres en simultané):
 * 1. Tag tous les membres ensemble dans UN SEUL message: (وينو عندو بوت) @user1 @user2 @user3
 * 2. Kick tous les membres ciblés sans taguer les admins
 */
async function executeAntiBotBatchProcedure(sock, jid, targetsList, groupData) {
  try {
    const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
    const botNumber = (sock.user?.id || '').split('@')[0].split(':')[0];

    let currentGroupData = groupData;
    try {
      const freshMeta = await getGroupDataSafely(sock, jid, true);
      if (freshMeta && freshMeta.participants) {
        currentGroupData = freshMeta;
      }
    } catch (_) {}

    const ownerJid = currentGroupData?.owner || currentGroupData?.subjectOwner || '';
    const ownerNumber = ownerJid ? ownerJid.split('@')[0].split(':')[0] : null;

    // Filtrer et résoudre les membres valides à kicker
    const validTargets = [];
    const targetsToProcess = Array.isArray(targetsList) ? targetsList : [targetsList];

    for (const target of targetsToProcess) {
      const rawTarget = typeof target === 'string' ? target : (target.rawJid || target.phone);
      const cleanPhone = String(rawTarget || '').split('@')[0].split(':')[0].replace(/[^0-9]/g, '');

      if (!cleanPhone || cleanPhone === botNumber || isSelfUser(sock, rawTarget)) continue;
      if (isSudo(cleanPhone) || isSudo(rawTarget)) continue;
      if (isPermanentWhitelisted(cleanPhone) || isPermanentWhitelisted(rawTarget)) continue;
      if (isBotAllowed(jid, cleanPhone) || isBotAllowed(jid, rawTarget)) continue;

      const resolved = await resolveGroupParticipant(sock, jid, rawTarget, currentGroupData);

      // Le créateur fondateur du groupe ne peut techniquement pas être expulsé par Baileys
      const isOwner = ownerNumber && resolved.phone === ownerNumber;
      if (isOwner) continue;

      const coolKey = `${jid}:${resolved.phone}`;
      const lastTrigger = antibotCooldown.get(coolKey) || 0;
      if (Date.now() - lastTrigger < 8000) continue;
      antibotCooldown.set(coolKey, Date.now());

      validTargets.push(resolved);
    }

    if (validTargets.length === 0) return;

    logActivity(`[AntiBotBatch] Exécution de l'expulsion groupée pour ${validTargets.length} membre(s) dans ${jid}`, 'warn');

    // 1. Tag tous les membres ensemble dans un seul message
    const tagsText = validTargets.map(t => t.tag).join(' ');
    const allUserMentions = Array.from(new Set(validTargets.flatMap(t => t.mentions)));

    await sock.sendPresenceUpdate('composing', jid).catch(() => {});
    await sleep(400);

    await sock.sendMessage(jid, {
      text: `(وينو عندو بوت) ${tagsText}`,
      mentions: allUserMentions
    });

    // 2. Kick tous les membres ciblés (rétrograder les admins détectés avant l'expulsion)
    for (const t of validTargets) {
      if (t.participant && (t.participant.admin === 'admin' || t.participant.admin === 'superadmin')) {
        const jidRem = t.participant?.id || t.participant?.jid || `${t.phone}@s.whatsapp.net`;
        await sock.groupParticipantsUpdate(jid, [jidRem], 'demote').catch(() => {});
      }
    }

    const jidsToRemove = validTargets.map(t => t.participant?.id || t.participant?.jid || `${t.phone}@s.whatsapp.net`);
    try {
      await safeGroupParticipantsRemove(sock, jid, jidsToRemove);
      logActivity(`[AntiBotBatch] ${validTargets.length} membre(s) expulsé(s).`);
    } catch (kErr) {
      logActivity(`[AntiBotBatch] Échec expulsion groupée: ${kErr.message}, tentative individuelle...`, 'warn');
      for (const t of validTargets) {
        const jidRem = t.participant?.id || t.participant?.jid || `${t.phone}@s.whatsapp.net`;
        await safeGroupParticipantsRemove(sock, jid, [jidRem]).catch(() => {});
      }
    }

  } catch (err) {
    console.error('Erreur executeAntiBotBatchProcedure:', err);
  }
}

async function executeAntiBotProcedure(sock, jid, targetJid, groupData) {
  return await executeAntiBotBatchProcedure(sock, jid, [targetJid], groupData);
}

/**
 * Module de Détection et Défense Anti-Bot lors de l'entrée dans le groupe
 */
async function handleAntiBotParticipantCheck(botPhone, sock, update) {
  try {
    const { id: jid, participants, action } = update;
    if (!jid || action !== 'add' || !participants || participants.length === 0) return;

    const botNumber = (sock.user?.id || '').split('@')[0].split(':')[0];

    // 1. PRIORITÉ ABSOLUE : Vérification immédiate Blacklist (SANS BESOIN DE SCAN OU D'ANTIBOT ACTIF)
    for (const p of participants) {
      let cleanPhone = resolveRealPhoneNumber(p);
      if (!cleanPhone || cleanPhone.length > 15 || String(p).endsWith('@lid')) {
        const usyncPhone = await resolveLidToPhoneViaUSync(sock, p);
        if (usyncPhone) cleanPhone = usyncPhone;
      }
      if (!cleanPhone) cleanPhone = String(p).split('@')[0].split(':')[0].replace(/[^0-9]/g, '');

      if (!cleanPhone || cleanPhone === botNumber || isSelfUser(sock, cleanPhone)) continue;
      if (isSudo(p) || isSudo(cleanPhone)) continue;

      if (isBannedUser(p) || isBannedUser(cleanPhone) || isNumberBlacklisted(p) || isNumberBlacklisted(cleanPhone)) {
        logActivity(`[Blacklist] Nouvel arrivant blacklisté @${cleanPhone} dans ${jid} -> Message et expulsion immédiate!`, 'warn');
        await sock.sendMessage(jid, {
          text: 'هههههه مبند هبط تشم الصبابط',
          mentions: [p, `${cleanPhone}@s.whatsapp.net`].filter(Boolean)
        }).catch(() => {});
        await safeGroupParticipantsRemove(sock, jid, [p]).catch(() => {});
        continue;
      }
    }

    // 2. Vérifier si l'Anti-Bot est activé dans ce groupe pour les autres membres (appareils liés)
    if (!isAntiBotEnabled(jid)) return;

    const detectedToKick = [];

    for (const p of participants) {
      let cleanPhone = resolveRealPhoneNumber(p);
      if (!cleanPhone || cleanPhone.length > 15 || String(p).endsWith('@lid')) {
        const usyncPhone = await resolveLidToPhoneViaUSync(sock, p);
        if (usyncPhone) cleanPhone = usyncPhone;
      }
      if (!cleanPhone) cleanPhone = String(p).split('@')[0].split(':')[0].replace(/[^0-9]/g, '');

      // Déjà traité si blacklisté
      if (isBannedUser(p) || isBannedUser(cleanPhone) || isNumberBlacklisted(p) || isNumberBlacklisted(cleanPhone)) {
        continue;
      }

      if (!cleanPhone || cleanPhone === botNumber || isSelfUser(sock, cleanPhone)) continue;
      if (isSudo(p) || isSudo(cleanPhone)) continue;
      if (isPermanentWhitelisted(p) || isPermanentWhitelisted(cleanPhone)) continue;
      if (isBotAllowed(jid, p) || isBotAllowed(jid, cleanPhone)) continue;

      const check = await checkUserHasLinkedDevices(sock, cleanPhone ? `${cleanPhone}@s.whatsapp.net` : p, true);
      if (check.hasLinked) {
        logActivity(`[AntiBot] Nouvel arrivant @${cleanPhone} lié à ${check.count} appareil(s) -> Expulsion!`, 'warn');
        detectedToKick.push(p);
      }
    }

    if (detectedToKick.length > 0) {
      await executeAntiBotBatchProcedure(sock, jid, detectedToKick, null);
    }
  } catch (err) {
    console.error('Erreur handleAntiBotParticipantCheck:', err);
  }
}

/**
 * Module de Détection Anti-Bot dans les demandes d'adhésion au groupe (Group Join Requests)
 * Alerte l'administration si le demandeur est lié à un bot/appareil et propose de le whitelister
 */
async function handleGroupJoinRequestSecurity(botPhone, sock, update) {
  try {
    const { id: jid, participant, action } = update;
    if (!jid || !participant) return;

    logActivity(`[JoinRequest] Demande d'adhésion de ${participant} dans ${jid} (action: ${action})`);

    const applicantPhone = participant.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');

    // Vérifier si le demandeur est banni globalement (.ban)
    if (isBannedUser(participant) || isBannedUser(applicantPhone)) {
      logActivity(`[GlobalBan] Demande d'adhésion d'un utilisateur banni @${applicantPhone} dans ${jid} -> Rejet immédiat`, 'warn');
      if (typeof sock.groupRequestParticipantsUpdate === 'function') {
        await sock.groupRequestParticipantsUpdate(jid, [participant], 'reject').catch(() => {});
      }
      return;
    }

    // Vérifier si le demandeur a des appareils liés (Web / Bot)
    const check = await checkUserHasLinkedDevices(sock, participant);
    if (!check.hasLinked) {
      logActivity(`[JoinRequest] Demandeur @${applicantPhone} est un compte WhatsApp normal (0 appareil).`);
      return;
    }

    logActivity(`[JoinRequest] ALERTE: Demandeur @${applicantPhone} a ${check.count} appareil(s) lié(s)!`, 'warn');

    // Vérifier s'il est déjà dans la whitelist
    const isWhitelisted = isBotAllowed(jid, participant) || isBotAllowed(jid, applicantPhone);

    // Récupérer les admins du groupe pour les notifier
    let groupData = null;
    try {
      groupData = await getGroupDataSafely(sock, jid);
    } catch (_) {}

    const botNumber = (sock.user?.id || '').split('@')[0].split(':')[0];
    const adminParticipants = groupData?.participants?.filter((adm) => {
      if (adm.admin !== 'admin' && adm.admin !== 'superadmin') return false;
      const admNum = (adm.id || adm.jid || '').split('@')[0].split(':')[0];
      return admNum !== applicantPhone && admNum !== botNumber;
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

    let alertText = `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚠️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
    alertText += `       🏰 *إمـبـراطـوريـة بـاراديـس* 🏰\n`;
    alertText += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 🚨 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n\n`;
    alertText += `🤖 *رادار الـكـشـف: طـلـب انـضـمـام مـن حـسـاب مـرتـبـط بـبـوت / ويـب!* 🤖\n\n`;
    alertText += `تـم رصـد طـلـب انـضـمـام جـديـد مـن حـسـاب مـرتـبـط بـأجـهـزة خـارجـيـة قـبـل قـبـولـه:\n\n`;
    alertText += `⋄ الـحـسـاب : @${applicantPhone}\n`;
    alertText += `⋄ عـدد الأجـهـزة الـمـرتـبـطـة : *${check.count} أجهزة* 📱\n`;
    alertText += `⋄ الـحـالـة : *مـعـلـق فـي الانـتـظـار (لـم يـتـم قـبـولـه)* ⏳\n\n`;

    if (isWhitelisted) {
      alertText += `🛡️ *حـالـة الـحـسـاب* : هـذا الـحـسـاب مـوجـود بـالـفـعـل فـي الـقـائـمـة الـبـيـضـاء (Whitelisted) لـن يـتـم طـرده عـنـد الـقـبـول ✅.\n\n`;
    } else {
      alertText += `⚠️ *تـنـبـيـه لـلإدارة* :\n`;
      alertText += `إذا تـم قـبـولـه دون إضـافـتـه لـلـقـائـمـة الـبـيـضـاء، فـسـيـقـوم مـضـاد الـبـوتـات بـطـرده فـوراً.\n\n`;
      alertText += `🛡️ *لإضـافـتـه لـلـقـائـمـة الـبـيـضـاء (الـسـمـاح لـه)* :\n`;
      alertText += `*.allowbot ${applicantPhone}*\n\n`;
      alertText += `✅ *لـقـبـول الـطـلـب* : *.accept ${applicantPhone}*\n`;
      alertText += `❌ *لـرفـض الـطـلـب* : *.reject ${applicantPhone}*\n\n`;
    }

    if (adminTags.length > 0) {
      alertText += `👑 *إشـعـار لـلـمـشـرفـيـن* :\n${adminTags.join(' ')}\n\n`;
    }
    alertText += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚔️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
    alertText += `       🏰 *PARADIS EMPIRE SECURITY* 🏰`;

    await sock.sendMessage(jid, {
      text: alertText,
      mentions: [...adminMentions, `${applicantPhone}@s.whatsapp.net`]
    });

  } catch (err) {
    console.error('Erreur handleGroupJoinRequestSecurity:', err);
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
    const isSudoUser = isSudo(senderId) || isSelfUser(sock, senderId);
    const lastMention = groupMentionCooldown.get(jid) || 0;
    const now = Date.now();
    if (!isSudoUser && now - lastMention < 45000) {
      await sock.sendMessage(jid, { 
        text: '⏳ *يـرجـى الانـتـظـار* : تـم اسـتـخـدام أمـر الـمـنـشـن حـديـثـاً فـي الـمـجـمـوعـة، انـتـظـر 45 ثـانـيـة لـحـمـايـة رقـم الـبـوت 🛡️' 
      });
      return;
    }
    groupMentionCooldown.set(jid, now);

    let currentGroupData = groupData;
    if (!currentGroupData || !currentGroupData.participants || currentGroupData.participants.length === 0) {
      try {
        currentGroupData = await getGroupDataSafely(sock, jid);
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

      // Ajouter uniquement le JID principal pour éviter de gonfler anormalement les stanzas WhatsApp
      if (primaryJid) {
        allMentions.add(primaryJid);
      } else if (p.id) {
        allMentions.add(p.id);
      }

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
    const botMode = isGroupMessage(jid) ? getGroupBotMode(jid) : getBotMode();

    let helpText = `⎔⋅• ━ ╼━ ╼╃ ⌬〔 🤖 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
    helpText += `       🏰 *إمـبـراطـوريـة بـاراديـس* 🏰\n`;
    helpText += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 🤖 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n\n`;
    helpText += `مـرحـبـاً بـك فـي الـبـوت الـرسـمـي لإمـبـراطـوريـة بـاراديـس ⚔️\n`;
    if (userPhone) {
      helpText += `📱 *رقم البوت المتصل* : ${userPhone}\n`;
    }
    helpText += `⚙️ *الـوضـع فـي هـذه الـمـجـمـوعـة* : ${botMode === 'private' ? '🔒 خـاص (Private)' : '🌍 عـام (Public)'}\n\n`;

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
`│ ⋄ *.requests* ⇠ فـحـص طـلـبـات الانـضـمـام وكـشـف الـبـوتـات 📥\n` +
`│ ⋄ *.antibot [on/off]* ⇠ تـفـعـيـل أو تـعـطـيـل طـرد الـبـوتـات تـلـقـائـيـاً 🤖\n` +
`│ ⋄ *.antispam [on/off]* ⇠ تـفـعـيـل أو تـعـطـيـل مـضـاد تـحـويـل الـسـبـام 🚨\n` +
`│ ⋄ *.antispamadd [on/off]* ⇠ حـمـايـة مـن سـبـام الإضـافـات وأرقـام الـتـبـنـيـد 🛡️\n` +
`│ ⋄ *.allowbot @عضو* ⇠ الـسـمـاح لـعـضـو بـاسـتـخـدام بـوت/ويـب (عـالـمـيـاً) 🌐\n` +
`│ ⋄ *.disallowbot @عضو* ⇠ إلـغـاء سـمـاح الـبـوت/ويـب (عـالـمـيـاً) 🚫\n` +
`│ ⋄ *.allowedbots* ⇠ قـائـمـة الـمـصـرح لـهـم بـالـبـوت والـويـب عـالـمـيـاً 📋\n` +
`│ ⋄ *.trust @عضو* ⇠ إضـافـة لـلـقـائـمـة الـبـيـضـاء الـدائـمـة (ثـقـة 100%) 🌟\n` +
`│ ⋄ *.untrust @عضو* ⇠ إلـغـاء الـثـقـة الـدائـمـة 🚫\n` +
`│ ⋄ *.trustlist* ⇠ قـائـمـة الأعـضـاء الـمـوثـوقـيـن دائـمـاً 🌟\n` +
`│ ⋄ *.accept [1 / 1 2 / 1,5 / all]* ⇠ قـبـول طـلـبـات الانـضـمـام ✅\n` +
`│ ⋄ *.reject [1 / 1 2 / 1,5 / all]* ⇠ رفـض طـلـبـات الانـضـمـام ❌\n` +
`│ ⋄ *.reset* ⇠ إعـادة تـعـيـيـن وتـجـديـد رابـط الـمـجـمـوعـة 🔄\n` +
`│ ⋄ *.antilink [on/off]* ⇠ تـفـعـيـل أو تـعـطـيـل مـضـاد الـروابـط 🛡️\n`;
      helpText += `│ ⋄ *.allowlink @عضو* ⇠ الـسـمـاح لـعـضـو بـإرسـال الـروابـط 🔗\n`;
      helpText += `│ ⋄ *.disallowlink @عضو* ⇠ إلـغـاء الـسـمـاح بـالـروابـط 🚫\n`;
      helpText += `│ ⋄ *.allowedlinks* ⇠ قـائـمـة الأعـضـاء الـمـسـمـوح لـهـم بـالـروابـط 📋\n`;
      helpText += `│ ⋄ *.warn @عضو* ⇠ إعـطـاء إنـذار (${CONFIG.maxWarnings} = طرد) ⚠️\n`;
      helpText += `│ ⋄ *.warnings @عضو* ⇠ فـحـص إنـذارات عـضـو 📋\n`;
      helpText += `│ ⋄ *.resetwarn @عضو* ⇠ تـصـفـيـر إنـذارات عـضـو 🔄\n`;
      helpText += `│ ⋄ *.kick @عضو* ⇠ طـرد عـضـو مـن الـمـجـمـوعـة 🚪\n`;
      helpText += `│ ⋄ *.allow @عضو* ⇠ الـسـمـاح لـعـضـو بـاسـتـخـدام الـبـوت (لـهـذه الـمـجـمـوعـة) 👤\n`;
      helpText += `│ ⋄ *.disallow @عضو* ⇠ إلـغـاء صـلاحـيـة اسـتـخـدام الـبـوت فـي الـمـجـمـوعـة 🚫\n`;
      helpText += `│ ⋄ *.allowedusers* ⇠ قـائـمـة الأعـضـاء الـمـصـرح لـهـم فـي هـذه الـمـجـمـوعـة 📋\n`;
      helpText += `╰─────────────────────⊷\n\n`;
    }

    if (senderIsSudo) {
      helpText += `╭───『 👑 أوامـر الـمـطـوريـن والـمـالـك (Sudo) 』───⊷\n`;
      helpText += `│ ⋄ *.mode [public/private]* ⇠ تـحـويـل وضـع الـبـوت لـلـمـجـمـوعـة ⚙️\n`;
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
    const isGroup = isGroupMessage(jid);
    const botMode = isGroup ? getGroupBotMode(jid) : getBotMode();
    const sudoCount = getSudoList().length;
    const antibotStatus = isGroup ? (isAntiBotEnabled(jid) ? '🟢 مـفـعـل (ON)' : '🔴 مـعـطـل (OFF)') : '🔴 مـعـطـل (OFF)';
    const antispamStatus = isGroup ? (isAntiSpamEnabled(jid) ? '🟢 مـفـعـل (ON)' : '🔴 مـعـطـل (OFF)') : '🔴 مـعـطـل (OFF)';

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
    text += `🤖 *مـضـاد الـبـوتـات* : ${antibotStatus}\n`;
    text += `🚨 *مـضـاد الـسـبـام* : ${antispamStatus}\n`;
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
      gData = await getGroupDataSafely(sock, jid);
    } catch (_) {}
  }

  let cleanTarget = String(targetId || '').split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
  if (lidToPhoneCache.has(cleanTarget)) {
    cleanTarget = lidToPhoneCache.get(cleanTarget);
  }

  const allMentions = new Set();
  if (targetId) allMentions.add(targetId);

  let phone = cleanTarget;
  let matchedParticipant = null;

  if (gData?.participants) {
    matchedParticipant = gData.participants.find((p) => {
      const pId = (p.id || '').split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
      const pJid = (p.jid || '').split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
      const pLid = (p.lid || '').split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
      return pId === cleanTarget || pJid === cleanTarget || pLid === cleanTarget;
    });

    if (matchedParticipant) {
      if (matchedParticipant.id) allMentions.add(matchedParticipant.id);
      if (matchedParticipant.jid) allMentions.add(matchedParticipant.jid);
      if (matchedParticipant.lid) allMentions.add(matchedParticipant.lid);

      // Prioriser le vrai numéro de téléphone (@s.whatsapp.net)
      if (matchedParticipant.jid && matchedParticipant.jid.endsWith('@s.whatsapp.net')) {
        phone = matchedParticipant.jid.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
      } else if (matchedParticipant.id && matchedParticipant.id.endsWith('@s.whatsapp.net')) {
        phone = matchedParticipant.id.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
      } else if (matchedParticipant.phoneNumber) {
        phone = String(matchedParticipant.phoneNumber).split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
      }
    }
  }

  if (lidToPhoneCache.has(phone)) {
    phone = lidToPhoneCache.get(phone);
  }

  if ((!phone || phone.length > 14) && typeof resolveLidToPhoneViaUSync === 'function') {
    try {
      const usyncPhone = await resolveLidToPhoneViaUSync(sock, targetId);
      if (usyncPhone) phone = usyncPhone;
    } catch (_) {}
  }

  if (phone) {
    allMentions.add(`${phone}@s.whatsapp.net`);
  }

  return {
    phone,
    tag: `+${phone} (@${phone})`,
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

/**
 * Commande .kicking [on/off] (Bot Owner Strictement)
 */
async function handleKickingToggleCommand(sock, jid, messageText, msg) {
  try {
    const words = messageText.trim().split(/\s+/);
    const arg = (words[1] || '').toLowerCase();

    if (arg === 'on' || arg === 'تشغيل' || arg === 'مفعل') {
      setKickingEnabled(true);
      let text = `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚙️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
      text += `       🏰 *إمـبـراطـوريـة بـاراديـس* 🏰\n`;
      text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚙️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n\n`;
      text += `🛡️ *إدارة خـاصـيـة الـطـرد (Kicking Setting)* 🛡️\n\n`;
      text += `✅ *تـم تـفـعـيـل خـاصـيـة الـطـرد (.kick)* بـنـجـاح.\n`;
      text += `⚠️ *تـنـبـيـه* : أعـضـاء قـائـمـة الـمـطـوريـن (Sudo List) مـحـمـيـون ولا يـمـكـن طـردهـم إلا مـن طـرف مـطـور آخـر.\n\n`;
      text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚔️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
      text += `       🏰 *PARADIS EMPIRE* 🏰`;
      await sock.sendMessage(jid, { text }, { quoted: msg });
      logActivity(`[Kicking] Activé par le Bot Owner`);
      return;
    }

    if (arg === 'off' || arg === 'تعطيل' || arg === 'معطل') {
      setKickingEnabled(false);
      let text = `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚙️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
      text += `       🏰 *إمـبـراطـوريـة بـاراديـس* 🏰\n`;
      text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚙️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n\n`;
      text += `🛡️ *إدارة خـاصـيـة الـطـرد (Kicking Setting)* 🛡️\n\n`;
      text += `⛔ *تـم تـعـطـيـل خـاصـيـة الـطـرد (.kick)* بـنـجـاح.\n`;
      text += `⋄ لـن يـتـم تـنـفـيـذ أي أمـر طـرد حـتـى إعـادة تـفـعـيـلـهـا مـن طـرف الـمـالـك.\n\n`;
      text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚔️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
      text += `       🏰 *PARADIS EMPIRE* 🏰`;
      await sock.sendMessage(jid, { text }, { quoted: msg });
      logActivity(`[Kicking] Désactivé par le Bot Owner`);
      return;
    }

    const isEnabled = isKickingEnabled();
    let text = `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚙️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
    text += `       🏰 *إمـبـراطـوريـة بـاراديـس* 🏰\n`;
    text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚙️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n\n`;
    text += `🛡️ *حـالـة خـاصـيـة الـطـرد (Kicking Status)* 🛡️\n\n`;
    text += `🔘 *الـحـالـة الـحـالـيـة* : ${isEnabled ? '✅ مـفـعـلـة (ON)' : '⛔ مـعـطـلـة (OFF)'}\n\n`;
    text += `⋄ لـلـتـفـعـيـل : *.kicking on*\n`;
    text += `⋄ لـلـتـعـطـيـل : *.kicking off*\n\n`;
    text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚔️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
    text += `       🏰 *PARADIS EMPIRE* 🏰`;
    await sock.sendMessage(jid, { text }, { quoted: msg });
  } catch (err) {
    console.error('Erreur handleKickingToggleCommand:', err);
  }
}

async function handleManualKickCommand(sock, jid, messageText, groupData, msg, senderIsSudo = false, isOwner = false) {
  try {
    const targetUserId = extractTargetUser(messageText, msg);
    if (!targetUserId) {
      await sock.sendMessage(jid, { text: '❌ *صيغة غير صحيحة*. مثال: *.kick @عضو* أو رد على رسالته بـ *.kick*' });
      return;
    }

    let currentGroupData = groupData;
    if (!currentGroupData || !currentGroupData.participants) {
      try {
        currentGroupData = await getGroupDataSafely(sock, jid);
      } catch (_) {}
    }

    const resolved = await resolveGroupParticipant(sock, jid, targetUserId, currentGroupData);
    const jidToRemove = resolved.participant?.id || resolved.participant?.jid || targetUserId;
    const targetPhone = resolved.phone;

    // Protection absolue des membres de la Sudo List:
    // Personne ne peut kicker un membre Sudo via le bot!
    let targetIsSudo = isSudo(targetUserId) || (targetPhone && isSudo(targetPhone)) || (targetPhone && PERMANENT_SUDOS.has(targetPhone));
    if (!targetIsSudo && targetPhone && targetPhone.length >= 9) {
      const last9 = targetPhone.slice(-9);
      for (const p of PERMANENT_SUDOS) {
        if (p.slice(-9) === last9) {
          targetIsSudo = true;
          break;
        }
      }
    }
    if (targetIsSudo && !senderIsSudo) {
      await sock.sendMessage(jid, {
        text: `🛡️ *حـمـايـة قـائـمـة الـسـوبـر أدمـيـن (Sudo)* 🛡️\n\n❌ لا يـمـكـن طـرد الـعـضـو ${resolved.tag} لأنـه يـنـتـمـي إلـى قـائـمـة الـمـطـوريـن (Sudo List) والـحـسـاب مـحـمـي تـمـامـاً مـن الـطـرد 👑.`,
        mentions: resolved.mentions
      }, { quoted: msg });
      return;
    }

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
      return;
    }

    // Protection compte bot
    const botNumber = (sock.user?.id || '').split('@')[0].split(':')[0];
    if (resolved.phone === botNumber || isSelfUser(sock, targetUserId) || isSelfUser(sock, resolved.phone)) {
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
    await safeGroupParticipantsRemove(sock, jid, [jidToRemove]);
    resetWarnings(jid, resolved.phone, resolved.mentions);
  } catch (err) {
    console.error('Erreur !kick:', err);
  }
}

/**
 * Commande secrète .ban <numéro / @user> (Sudo / Owner uniquement - non répertoriée)
 * Bannit globalement un spammeur : le bloque sur WhatsApp, l'enregistre en base,
 * et l'expulse de tous les groupes actuels et futurs où le bot est présent.
 */
async function handleBanCommand(sock, jid, messageText, msg, senderIsSudo) {
  try {
    if (!senderIsSudo) return;

    let targetNumber = null;
    let targetJid = null;

    // 1. Participant cité en réponse
    const quotedParticipant = msg?.message?.extendedTextMessage?.contextInfo?.participant;
    if (quotedParticipant) {
      targetNumber = String(quotedParticipant).split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
      targetJid = `${targetNumber}@s.whatsapp.net`;
    }

    // 2. Mention @ dans le texte
    if (!targetNumber) {
      const match = messageText.match(/@(\d+)/);
      if (match) {
        targetNumber = match[1].replace(/[^0-9]/g, '');
        targetJid = `${targetNumber}@s.whatsapp.net`;
      }
    }

    // 3. Numéro de téléphone brut tapé dans la commande (ex: .ban 212612345678 ou .ban +212 612-345678)
    if (!targetNumber) {
      const words = messageText.trim().split(/\s+/).slice(1);
      const potential = words.join('').replace(/[^0-9]/g, '');
      if (potential.length >= 7) {
        targetNumber = potential;
        targetJid = `${targetNumber}@s.whatsapp.net`;
      }
    }

    if (!targetNumber) {
      await sock.sendMessage(jid, {
        text: `❌ *يـرجـى تـحـديـد الـرقـم أو الـعـضـو الـمـراد حـظـره* :\n\n⋄ اكـتـب الـرقـم : *.ban 2126xxxxxxx*\n⋄ أو مـنـشـن : *.ban @عضو*\n⋄ أو قـم بـالـرد عـلـى رسـالـتـه بـكـتـابـة *.ban*`
      });
      return;
    }

    // Protection des SUDO / Propriétaires
    if (PERMANENT_SUDOS.has(targetNumber) || isSudo(targetNumber)) {
      await sock.sendMessage(jid, {
        text: `⚠️ *عـفـواً!* لا يـمـكـن حـظـر أحـد الـمـطـوريـن الـمـعـتـمـديـن 👑🛡️`
      });
      return;
    }

    // 1. Enregistrement dans la base de données (Blacklist globale permanente)
    addBannedUser(targetNumber);

    // 2. Blocage direct sur WhatsApp (pour tous les comptes de bot connectés)
    for (const [, sess] of sessions.entries()) {
      if (sess?.sock && sess.status === 'connected') {
        await safeBlockUser(sess.sock, targetJid).catch(() => {});
      }
    }

    // 3. Expulsion de tous les groupes actuels où ce spammeur est présent
    let kickedGroupsCount = 0;
    try {
      if (typeof sock.groupFetchAllParticipating === 'function') {
        const participating = await sock.groupFetchAllParticipating();
        const groups = Object.values(participating);
        for (const g of groups) {
          const gId = g.id;
          const participants = g.participants || [];
          const found = participants.find((p) => {
            const pNum = (p.id || p.jid || '').split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
            return pNum === targetNumber;
          });
          if (found) {
            const pRem = found.id || found.jid || targetJid;
            if (found.admin === 'admin' || found.admin === 'superadmin') {
              await sock.groupParticipantsUpdate(gId, [pRem], 'demote').catch(() => {});
            }
            await safeGroupParticipantsRemove(sock, gId, [pRem]).catch(() => {});
            kickedGroupsCount++;
          }
        }
      }
    } catch (e) {
      logActivity(`[Ban] Erreur scan groupes: ${e.message}`, 'warn');
    }

    // Si on est dans un groupe et que la personne y est, la kicker immédiatement
    if (isGroupMessage(jid)) {
      await safeGroupParticipantsRemove(sock, jid, [targetJid]).catch(() => {});
    }

    let text = `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⛔ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
    text += `       🏰 *إمـبـراطـوريـة بـاراديـس* 🏰\n`;
    text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⛔ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n\n`;
    text += `⛔ *تـم الـحـظـر والـطـرد الـشـامـل (Global Ban)* ⛔\n\n`;
    text += `⋄ الـرقـم الـمـحـظـور : *+${targetNumber}*\n`;
    text += `⋄ الـحـالـة : 🔒 تـم حـظـره فـي الـواتـسـاب وإدراجه في القائمة السوداء الدائمة.\n`;
    text += `⋄ عـدد الـمـجـمـوعـات الـتـي طُـرد مـنـهـا حـالـيـاً : *${kickedGroupsCount}*\n`;
    text += `⋄ الـحـمـايـة : لـن يـتـمـكـن مـن مـراسـلـة الـبـوت، وسـيُـطـرد فـوراً وتـلـقـائـيـاً إذا حـاول دخـول أي مـجـمـوعـة تـابـعـة 🛡️.\n\n`;
    text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚔️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
    text += `       🏰 *PARADIS EMPIRE* 🏰`;

    await sock.sendMessage(jid, { text });
    logActivity(`[GlobalBan] +${targetNumber} banni par sudo dans ${jid}`);
  } catch (err) {
    console.error('Erreur handleBanCommand:', err);
  }
}

/**
 * Commande secrète .unban <numéro / @user> (Sudo / Owner uniquement - non répertoriée)
 */
async function handleUnbanCommand(sock, jid, messageText, msg, senderIsSudo) {
  try {
    if (!senderIsSudo) return;

    let targetNumber = null;
    let targetJid = null;

    const quotedParticipant = msg?.message?.extendedTextMessage?.contextInfo?.participant;
    if (quotedParticipant) {
      targetNumber = String(quotedParticipant).split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
      targetJid = `${targetNumber}@s.whatsapp.net`;
    }

    if (!targetNumber) {
      const match = messageText.match(/@(\d+)/);
      if (match) {
        targetNumber = match[1].replace(/[^0-9]/g, '');
        targetJid = `${targetNumber}@s.whatsapp.net`;
      }
    }

    if (!targetNumber) {
      const words = messageText.trim().split(/\s+/).slice(1);
      const potential = words.join('').replace(/[^0-9]/g, '');
      if (potential.length >= 7) {
        targetNumber = potential;
        targetJid = `${targetNumber}@s.whatsapp.net`;
      }
    }

    if (!targetNumber) {
      await sock.sendMessage(jid, {
        text: `❌ *يـرجـى تـحـديـد الـرقـم لإلـغـاء حـظـره* : *.unban 2126xxxxxxx*`
      });
      return;
    }

    removeBannedUser(targetNumber);
    BLACKLISTED_TABNEED_NUMBERS.delete(targetNumber);

    // Débloquer sur WhatsApp
    for (const [, sess] of sessions.entries()) {
      if (sess?.sock && sess.status === 'connected') {
        await sess.sock.updateBlockStatus(targetJid, 'unblock').catch(() => {});
      }
    }

    let text = `⎔⋅• ━ ╼━ ╼╃ ⌬〔 🔓 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
    text += `       🏰 *إمـبـراطـوريـة بـاراديـس* 🏰\n`;
    text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 🔓 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n\n`;
    text += `🔓 *تـم إلـغـاء الـحـظـر (Unban)* 🔓\n\n`;
    text += `⋄ الـرقـم : *+${targetNumber}*\n`;
    text += `⋄ تـم رفـع الـحـظـر عـن الـحـسـاب وإلـغـاء إدراجـه فـي الـقـائـمـة الـسـوداء ✅.\n\n`;
    text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚔️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
    text += `       🏰 *PARADIS EMPIRE* 🏰`;

    await sock.sendMessage(jid, { text });
    logActivity(`[Unban] +${targetNumber} débanni par sudo dans ${jid}`);
  } catch (err) {
    console.error('Erreur handleUnbanCommand:', err);
  }
}

/**
 * Commande .blacklist / .banlist (Sudo / Owner uniquement)
 * Affiche l'ensemble des numéros figurant dans la liste noire
 */
async function handleBlacklistCommand(sock, jid, msg) {
  try {
    const dbBanned = getBannedUsers();
    const combinedSet = new Set([...dbBanned, ...BLACKLISTED_TABNEED_NUMBERS]);
    const bannedList = Array.from(combinedSet);

    const mentions = [];
    let text = `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⛔ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
    text += `       🏰 *إمـبـراطـوريـة بـاراديـس* 🏰\n`;
    text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⛔ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n\n`;
    text += `⛔ *الـقـائـمـة الـسـوداء الـشـامـلـة (BLACKLIST)* (${bannedList.length}) ⛔\n\n`;

    if (bannedList.length === 0) {
      text += `✨ لا يـوجـد أي رقـم مـحـظـور حـالـيـاً فـي الـقـائـمـة الـسـوداء.\n\n`;
    } else {
      for (let i = 0; i < bannedList.length; i++) {
        const phone = bannedList[i];
        text += `• ${i + 1}. +${phone} (@${phone})\n`;
        mentions.push(`${phone}@s.whatsapp.net`);
      }
      text += `\n`;
    }

    text += `──────────────────────\n`;
    text += `💡 *إدارة الـقـائـمـة الـسـوداء* :\n`;
    text += `⋄ لـحـظـر رقـم جـديـد : *.ban +212xxxxxxx*\n`;
    text += `⋄ لإلـغـاء حـظـر رقـم : *.unban +212xxxxxxx*\n\n`;
    text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚔️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
    text += `       🏰 *PARADIS EMPIRE SECURITY* 🏰`;

    await sock.sendMessage(jid, { text, mentions }, { quoted: msg });
  } catch (err) {
    console.error('Erreur handleBlacklistCommand:', err);
  }
}

/**
 * Commande .mode [public/private]
 */
async function handleModeCommand(sock, jid, messageText, senderIsSudo) {
  try {
    if (!senderIsSudo) {
      return;
    }

    const isGroup = isGroupMessage(jid);
    const words = messageText.trim().split(/\s+/);
    const arg = (words[1] || '').toLowerCase();

    if (arg === 'public' || arg === 'عام') {
      if (isGroup) {
        setGroupBotMode(jid, 'public');
      } else {
        setBotMode('public');
      }
      let text = `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚙️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
      text += `       🏰 *إمـبـراطـوريـة بـاراديـس* 🏰\n`;
      text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚙️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n\n`;
      text += `🌍 *تـم تـفـعـيـل الـوضـع الـعـام (Public Mode)* 🌍\n\n`;
      text += isGroup 
        ? `⋄ أصـبـح بـإمـكـان كـافـة أعـضـاء هـذه الـمـجـمـوعـة اسـتـخـدام أوامـر الـبـوت.\n\n`
        : `⋄ أصـبـح بـإمـكـان كـافـة الأعـضـاء اسـتـخـدام أوامـر الـبـوت الـمـتـاحـة.\n\n`;
      text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚔️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
      text += `       🏰 *PARADIS EMPIRE* 🏰`;
      await sock.sendMessage(jid, { text });
      logActivity(`[Mode] Changé à PUBLIC dans ${jid} par sudo`);
      return;
    }

    if (arg === 'private' || arg === 'خاص') {
      if (isGroup) {
        setGroupBotMode(jid, 'private');
      } else {
        setBotMode('private');
      }
      let text = `⎔⋅• ━ ╼━ ╼╃ ⌬〔 🔒 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
      text += `       🏰 *إمـبـراطـوريـة بـاراديـس* 🏰\n`;
      text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 🔒 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n\n`;
      text += `🔒 *تـم تـفـعـيـل الـوضـع الـخـاص (Private Mode)* 🔒\n\n`;
      text += isGroup
        ? `⋄ لا يـمـكـن لأحـد اسـتـخـدام الـبـوت فـي هـذه الـمـجـمـوعـة سـوى الـمـطـوريـن (Sudo) والأعـضـاء الـمـصـرح لـهـم فـقـط.\n\n`
        : `⋄ لا يـمـكـن لأحـد اسـتـخـدام الـبـوت سـوى مـالـك الـبـوت وقـائـمـة الـمـطـوريـن (Sudo List) فـقـط.\n\n`;
      text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚔️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
      text += `       🏰 *PARADIS EMPIRE* 🏰`;
      await sock.sendMessage(jid, { text });
      logActivity(`[Mode] Changé à PRIVATE dans ${jid} par sudo`);
      return;
    }

    // Afficher le mode actuel
    const currentMode = isGroup ? getGroupBotMode(jid) : getBotMode();
    let text = `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚙️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
    text += `       🏰 *إمـبـراطـوريـة بـاراديـس* 🏰\n`;
    text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚙️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n\n`;
    text += isGroup
      ? `⚙️ *وضـع الـبـوت فـي هـذه الـمـجـمـوعـة* : ${currentMode === 'private' ? '🔒 خـاص (Private)' : '🌍 عـام (Public)'}\n\n`
      : `⚙️ *وضـع الـبـوت الـعـام* : ${currentMode === 'private' ? '🔒 خـاص (Private)' : '🌍 عـام (Public)'}\n\n`;
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
    const cleanPhone = targetNumber.replace(/[^0-9]/g, '');

    if (cleanPhone === '212603125628' || cleanPhone === '212781848716' || cleanPhone === '212767016197' || cleanPhone === '212771313350') {
      await sock.sendMessage(jid, { 
        text: `⚠️ هـذا الـرقـم مـخـصـص كـجـهـاز مـرتـبـط مـوثـوق (Trusted Linked Device) فـقـط ولا يـمـكـن إضـافـتـه لـقـائـمـة الـمـطـوريـن.`
      }, { quoted: msg });
      return;
    }

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
    const cleanPhone = targetNumber.replace(/[^0-9]/g, '');

    if (PERMANENT_SUDOS.has(cleanPhone)) {
      let text = `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚠️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
      text += `       🏰 *إمـبـراطـوريـة بـاراديـس* 🏰\n`;
      text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚠️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n\n`;
      text += `👑 *حـمـايـة الـمـطـوريـن الـدائـمـيـن (Permanent Sudo)* 👑\n\n`;
      text += `⋄ الـعـضـو : @${cleanPhone}\n`;
      text += `⋄ هـذا الـحـسـاب مـن الـمـطـوريـن الأسـاسـيـيـن الـدائـمـيـن ولا يـمـكـن حـذفـه أو تـجـريـده مـن الـصـلاحـيـة نـهـائـيـاً 🛡️.\n\n`;
      text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚔️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
      text += `       🏰 *PARADIS EMPIRE* 🏰`;
      await sock.sendMessage(jid, { text, mentions: [targetUserId] });
      return;
    }

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
    const rawSudoList = getSudoList();
    const cleanNumbers = [];
    const mentions = [];

    for (const u of rawSudoList) {
      let phone = String(u).split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
      if (lidToPhoneCache && lidToPhoneCache.has(phone)) {
        phone = lidToPhoneCache.get(phone);
      }
      if (phone && !cleanNumbers.includes(phone)) {
        cleanNumbers.push(phone);
        mentions.push(`${phone}@s.whatsapp.net`);
      }
    }

    let text = `⎔⋅• ━ ╼━ ╼╃ ⌬〔 👑 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
    text += `       🏰 *إمـبـراطـوريـة بـاراديـس* 🏰\n`;
    text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 👑 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n\n`;
    text += `👑 *قـائـمـة الـمـطـوريـن الـمـعـتـمـديـن (Sudo List)* (${cleanNumbers.length}) :\n\n`;

    if (cleanNumbers.length === 0) {
      text += `⋄ لا يـوجـد مـطـوريـن إضـافـيـيـن حـالـيـاً.\n⋄ (مـالـك حـسـاب الـبـوت يـمـلـك الـصـلاحـيـة تـلـقـائـيـاً).\n\n`;
    } else {
      for (let i = 0; i < cleanNumbers.length; i++) {
        const phone = cleanNumbers[i];
        text += `• ${i + 1}. +${phone} (@${phone})\n`;
      }
      text += `\n`;
    }

    text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚔️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
    text += `       🏰 *PARADIS EMPIRE* 🏰`;

    await sock.sendMessage(jid, { text, mentions });
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
      currentGroupData = await getGroupDataSafely(sock, jid);
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
      currentGroupData = await getGroupDataSafely(sock, jid);
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
      currentGroupData = await getGroupDataSafely(sock, jid);
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
 * Commande .antispam on / .antispam off (Group Admins / Sudo)
 */
async function handleAntiSpamToggleCommand(sock, jid, messageText, senderIsAdmin, senderIsSudo) {
  try {
    if (!senderIsAdmin && !senderIsSudo) {
      return;
    }

    const words = messageText.trim().split(/\s+/);
    const arg = (words[1] || '').toLowerCase();

    if (arg === 'on' || arg === 'تشغيل' || arg === 'تفعيل') {
      setAntiSpamEnabled(jid, true);
      let text = `⎔⋅• ━ ╼━ ╼╃ ⌬〔 🚨 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
      text += `       🏰 *إمـبـراطـوريـة بـاراديـس* 🏰\n`;
      text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 🚨 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n\n`;
      text += `🚨 *تـم تـفـعـيـل مـضـاد الـسـبـام (Anti-Spam ON)*\n\n`;
      text += `⋄ سـيـتـم مـراقـبـة تـحـويـل الـرسـائـل الـمـتـتـابـعـة فـي الـمـجـمـوعـة.\n`;
      text += `⋄ عـنـد رصـد تـحـويـل سـريـع ومـتـكـرر، سـيـتـم قـفـل الـمـجـمـوعـة وتـجـريـد الـمـخـالـف مـن الإشـراف 🔒.\n\n`;
      text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚔️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
      text += `       🏰 *PARADIS EMPIRE* 🏰`;
      await sock.sendMessage(jid, { text });
      logActivity(`[AntiSpam] Activé dans ${jid}`);
      return;
    }

    if (arg === 'off' || arg === 'تعطيل' || arg === 'ايقاف') {
      setAntiSpamEnabled(jid, false);
      let text = `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚠️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
      text += `       🏰 *إمـبـراطـوريـة بـاراديـس* 🏰\n`;
      text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚠️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n\n`;
      text += `⚠️ *تـم إيـقـاف مـضـاد الـسـبـام (Anti-Spam OFF)*\n\n`;
      text += `⋄ تـم الـسـمـاح بـتـحـويـل الـرسـائـل دون قـفـل الـمـجـمـوعـة أو عـقـوبـات.\n\n`;
      text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚔️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
      text += `       🏰 *PARADIS EMPIRE* 🏰`;
      await sock.sendMessage(jid, { text });
      logActivity(`[AntiSpam] Désactivé dans ${jid}`);
      return;
    }

    // Afficher statut actuel
    const currentStatus = isAntiSpamEnabled(jid);
    let text = `⎔⋅• ━ ╼━ ╼╃ ⌬〔 🚨 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
    text += `       🏰 *إمـبـراطـوريـة بـاراديـس* 🏰\n`;
    text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 🚨 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n\n`;
    text += `🚨 *حـالـة مـضـاد الـسـبـام* : ${currentStatus ? '🟢 مـفـعـل (ON)' : '🔴 مـعـطـل (OFF)'}\n\n`;
    text += `⋄ لـلـتـفـعـيـل : *.antispam on*\n`;
    text += `⋄ لـلـتـعـطـيـل : *.antispam off*\n\n`;
    text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚔️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
    text += `       🏰 *PARADIS EMPIRE* 🏰`;
    await sock.sendMessage(jid, { text });
  } catch (err) {
    console.error('Erreur handleAntiSpamToggleCommand:', err);
  }
}

/**
 * Commande .antispamadd on / .antispamadd off (Group Admins / Sudo)
 * Protège le groupe contre les attaques par flood d'ajouts de membres (Add-to-Group Spam / Tabneed)
 */
async function handleAntiSpamAddToggleCommand(sock, jid, messageText, senderIsAdmin, senderIsSudo) {
  try {
    if (!senderIsAdmin && !senderIsSudo) {
      return;
    }

    const words = messageText.trim().split(/\s+/);
    const arg = (words[1] || '').toLowerCase();

    if (arg === 'on' || arg === 'تشغيل' || arg === 'تفعيل') {
      setAntiSpamAddEnabled(jid, true);
      let text = `⎔⋅• ━ ╼━ ╼╃ ⌬〔 🛡️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
      text += `       🏰 *إمـبـراطـوريـة بـاراديـس* 🏰\n`;
      text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 🛡️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n\n`;
      text += `🛡️ *تـم تـفـعـيـل مـضـاد سـبـام الإضـافـات (Anti-Spam Add ON)*\n\n`;
      text += `⋄ سـيـتـم رصـد وحـظـر أي هـجـوم إضـافـات مـكـثـف (Add-to-Group Spam) أو أرقـام تـبـنـيـد مـعـاديـة.\n`;
      text += `⋄ الـمـشـرفـون ومـطـورو الـبـوت والـقـائـمـة الـبـيـضـاء مـسـتـثـنـون تـمـامـاً ومـحـمـيـون ✅.\n\n`;
      text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚔️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
      text += `       🏰 *PARADIS EMPIRE* 🏰`;
      await sock.sendMessage(jid, { text });
      logActivity(`[AntiSpamAdd] Activé dans ${jid}`);
      return;
    }

    if (arg === 'off' || arg === 'تعطيل' || arg === 'ايقاف') {
      setAntiSpamAddEnabled(jid, false);
      let text = `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚠️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
      text += `       🏰 *إمـبـراطـوريـة بـاراديـس* 🏰\n`;
      text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚠️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n\n`;
      text += `⚠️ *تـم إيـقـاف مـضـاد سـبـام الإضـافـات (Anti-Spam Add OFF)*\n\n`;
      text += `⋄ يـمـكـن لـلـمـشـرفـيـن قـبـول كـافـة طـلـبـات الانـضـمـام وإضـافـة الأعـضـاء بـحـريـة تـامـة.\n\n`;
      text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚔️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
      text += `       🏰 *PARADIS EMPIRE* 🏰`;
      await sock.sendMessage(jid, { text });
      logActivity(`[AntiSpamAdd] Désactivé dans ${jid}`);
      return;
    }

    // Afficher statut actuel
    const currentStatus = isAntiSpamAddEnabled(jid);
    let text = `⎔⋅• ━ ╼━ ╼╃ ⌬〔 🛡️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
    text += `       🏰 *إمـبـراطـوريـة بـاراديـس* 🏰\n`;
    text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 🛡️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n\n`;
    text += `🛡️ *حـالـة مـضـاد سـبـام الإضـافـات* : ${currentStatus ? '🟢 مـفـعـل (ON)' : '🔴 مـعـطـل (OFF)'}\n\n`;
    text += `⋄ لـلـتـفـعـيـل : *.antispamadd on*\n`;
    text += `⋄ لـلـتـعـطـيـل : *.antispamadd off*\n\n`;
    text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚔️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
    text += `       🏰 *PARADIS EMPIRE* 🏰`;
    await sock.sendMessage(jid, { text });
  } catch (err) {
    console.error('Erreur handleAntiSpamAddToggleCommand:', err);
  }
}

/**
 * Commande .scan (Group Admins / Sudo)
 * Scanne tous les membres du groupe pour détecter ceux qui ont lié leur WhatsApp à un appareil/bot
 * Affiche UNIQUEMENT les personnes détectées avec leur numéro réel (aucun ID/LID, aucun membre safe)
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
        currentGroupData = await getGroupDataSafely(sock, jid);
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
    const blacklistedDetected = [];

    // Map pour retrouver rapidement chaque participant par son vrai numéro de téléphone
    const phoneToParticipant = new Map();
    const phoneJids = [];

    for (const p of participants) {
      let cleanPhone = null;
      if (p.jid && p.jid.endsWith('@s.whatsapp.net')) {
        cleanPhone = p.jid.split('@')[0].split(':')[0];
      } else if (p.id && p.id.endsWith('@s.whatsapp.net')) {
        cleanPhone = p.id.split('@')[0].split(':')[0];
      } else if (p.phoneNumber) {
        cleanPhone = String(p.phoneNumber).replace(/[^0-9]/g, '');
      } else {
        cleanPhone = (p.id || p.jid || '').split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
      }

      if (!cleanPhone || cleanPhone === botNumber || isSelfUser(sock, cleanPhone)) continue;
      if (isSudo(cleanPhone) || isPermanentWhitelisted(cleanPhone)) continue;

      const rawJid = p.id || p.jid || `${cleanPhone}@s.whatsapp.net`;
      const isBl = isBannedUser(cleanPhone) || isBannedUser(rawJid) || isNumberBlacklisted(cleanPhone) || isNumberBlacklisted(rawJid);

      if (isBl) {
        blacklistedDetected.push({
          phone: cleanPhone,
          rawJid: rawJid,
          tag: `@${cleanPhone}`,
          mentions: [`${cleanPhone}@s.whatsapp.net`, rawJid].filter(Boolean),
          isAdmin: p.admin === 'admin' || p.admin === 'superadmin'
        });
        continue; // Banni/Blacklisté -> Détecté et programmé pour expulsion immédiate
      }

      const standardPhoneJid = `${cleanPhone}@s.whatsapp.net`;
      phoneToParticipant.set(cleanPhone, {
        phone: cleanPhone,
        rawJid: rawJid,
        isAdmin: p.admin === 'admin' || p.admin === 'superadmin'
      });
      phoneJids.push(standardPhoneJid);
    }

    // Diviser les requêtes USync en lots de 25
    const chunkSize = 25;
    for (let i = 0; i < phoneJids.length; i += chunkSize) {
      const batch = phoneJids.slice(i, i + chunkSize);
      try {
        if (typeof sock.getUSyncDevices === 'function') {
          const devices = await sock.getUSyncDevices(batch, false, false);
          if (Array.isArray(devices)) {
            for (const dev of devices) {
              const devId = Number(dev.device);
              if (!isNaN(devId) && devId > 0) {
                const userPhone = String(dev.user || '').replace(/[^0-9]/g, '');
                if (!userPhone || userPhone === botNumber || isSelfUser(sock, userPhone)) continue;

                let entry = detected.find((d) => d.phone === userPhone);
                if (!entry) {
                  const pInfo = phoneToParticipant.get(userPhone);
                  const rawJid = pInfo?.rawJid || `${userPhone}@s.whatsapp.net`;
                  entry = {
                    phone: userPhone,
                    rawJid: rawJid,
                    tag: `@${userPhone}`,
                    mentions: [`${userPhone}@s.whatsapp.net`, rawJid],
                    deviceCount: 0,
                    isAdmin: pInfo ? pInfo.isAdmin : false
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
    text += `📊 *تـقـريـر فـحـص الأجـهـزة والـقـائـمـة الـسـوداء (Scan)* 📊\n\n`;
    text += `⋄ الـحـسـابـات الـمـرتـبـطـة بـأجـهـزة / بـوت : *${detected.length}*\n`;
    text += `⋄ الـحـسـابـات الـمـحـظـورة (Blacklist) : *${blacklistedDetected.length}*\n`;
    text += `⋄ حـالـة مـضـاد الـبـوتـات : *${antibotActive ? '🟢 مـفـعـل (طـرد تـلـقـائـي)' : '🔴 مـعـطـل (عـرض اسـتـطـلاعـي - بـدون طـرد)'}*\n\n`;

    const allMentions = [];
    const membersToKick = [];

    if (blacklistedDetected.length > 0) {
      text += `🚫 *قـائـمـة الـحـسـابـات الـمـحـظـورة الـمـكـتـشـفـة (Blacklist)* :\n\n`;
      blacklistedDetected.forEach((item, idx) => {
        text += `⛔ +${item.phone} (@${item.phone}) ↬ 👢 *طـرد فـوري ومـبـاشـر* 🚫\n`;
        allMentions.push(...item.mentions);
      });
      text += `\n`;
    }

    if (detected.length === 0) {
      text += `✅ *لا يـوجـد أي حـسـاب مـرتـبـط بـأجـهـزة/بـوت فـي هـذه الـمـجـمـوعـة.* 🛡️\n\n`;
    } else {
      text += `⚠️ *قـائـمـة الـحـسـابـات الـمـرتـبـطـة الـمـكـتـشـفـة* :\n\n`;
      detected.forEach((item, idx) => {
        const isPermanent = isPermanentWhitelisted(item.phone) || isPermanentWhitelisted(item.rawJid);
        const isWhitelisted = isPermanent || isBotAllowed(jid, item.phone) || isBotAllowed(jid, item.rawJid);
        let statusBadge = '';
        if (item.isAdmin) {
          statusBadge = '👑 مشرف (مستثنى)';
        } else if (isPermanent) {
          statusBadge = '🛡️ قـائـمـة بـيـضـاء دائـمـة (ثـقـة 100%)';
        } else if (isWhitelisted) {
          statusBadge = '🛡️ مـسـمـوح لـه (Whitelist)';
        } else if (antibotActive) {
          statusBadge = '👤 عضو ↬ 👢 *جـاري الـطـرد*';
          membersToKick.push(item);
        } else {
          statusBadge = '👤 عضو (مـرتـبـط - بـدون طـرد)';
        }

        text += `${idx + 1}️⃣ +${item.phone} (@${item.phone}) (${statusBadge}) ↬ *${item.deviceCount} جهاز مرتبط* 🤖\n`;
        allMentions.push(...item.mentions);
      });
      if (!antibotActive) {
        text += `\nℹ️ *مـضـاد الـبـوتـات مـعـطـل* : هـذا الـفـحـص اسـتـطـلاعـي فـقـط، لـن يـتـم طـرد أي عـضـو حـتـى تـفـعـل الـنـظـام بـأمـر *.antibot on*.\n`;
      }
      text += `\n`;
    }

    text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚔️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
    text += `       🏰 *PARADIS EMPIRE SCANNER* 🏰`;

    await sock.sendMessage(jid, {
      text,
      mentions: Array.from(new Set(allMentions))
    });

    // Exécuter l'expulsion immédiate des comptes blacklistés avec le message requis
    if (blacklistedDetected.length > 0) {
      const bMentions = [];
      const bJids = [];
      for (const b of blacklistedDetected) {
        bMentions.push(...b.mentions);
        bJids.push(b.rawJid);
        if (b.isAdmin) {
          await sock.groupParticipantsUpdate(jid, [b.rawJid], 'demote').catch(() => {});
        }
      }
      await sock.sendMessage(jid, {
        text: 'هههههه مبند هبط تشم الصبابط',
        mentions: Array.from(new Set(bMentions))
      }).catch(() => {});
      await safeGroupParticipantsRemove(sock, jid, bJids).catch(() => {});
    }

    // Exécuter l'expulsion groupée si Anti-Bot est activé
    if (antibotActive && membersToKick.length > 0) {
      await executeAntiBotBatchProcedure(sock, jid, membersToKick, currentGroupData);
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

/**
 * Commande .allowbot / .allowbots @user / number (Group Admins / Sudo)
 * Ajoute un utilisateur à la whitelist Anti-Bot
 */
async function handleAllowBotCommand(sock, jid, messageText, msg, senderIsAdmin, senderIsSudo) {
  try {
    if (!senderIsAdmin && !senderIsSudo) {
      return;
    }

    let targetUserId = extractTargetUser(messageText, msg);
    if (!targetUserId) {
      const words = messageText.trim().split(/\s+/);
      if (words[1]) {
        const num = words[1].replace(/[^0-9]/g, '');
        if (num.length >= 7) targetUserId = `${num}@s.whatsapp.net`;
      }
    }

    if (!targetUserId) {
      await sock.sendMessage(jid, { 
        text: '❌ *يـرجـى تـحـديـد الـعـضـو* :\n⋄ قـم بـعـمـل مـنـشـن : *.allowbot @عضو*\n⋄ أو اكـتـب الـرقـم : *.allowbot 212xxxxxxx*\n⋄ أو قـم بـالـرد عـلـى رسـالـتـه بـكـتـابـة *.allowbot*' 
      });
      return;
    }

    const resolved = await resolveGroupParticipant(sock, jid, targetUserId, null);
    allowBotUser(jid, resolved.phone);

    let text = `⎔⋅• ━ ╼━ ╼╃ ⌬〔 🛡️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
    text += `       🏰 *إمـبـراطـوريـة بـاراديـس* 🏰\n`;
    text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 🛡️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n\n`;
    text += `🛡️ *تـمـت الإضـافـة لـلـقـائـمـة الـبـيـضـاء الـشـامـلـة (Global Whitelist)*\n\n`;
    text += `⋄ الـعـضـو : ${resolved.tag}\n`;
    text += `⋄ تـم تـصـريـحـه عـالـمـيـاً فـي *جـمـيـع مـجـمـوعـات الإمـبـراطـوريـة* (الـحـالـيـة والـمـسـتـقـبـلـيـة) 🌐.\n`;
    text += `⋄ لـن يـتـم طـرده أبـداً عـنـد اسـتـخـدام واتـسـاب ويـب أو كـمـبـيـوتـر أو بـوت (ثـقـة تـامـة) ✅.\n\n`;
    text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚔️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
    text += `       🏰 *PARADIS EMPIRE* 🏰`;

    await sock.sendMessage(jid, { text, mentions: resolved.mentions });
    logActivity(`[AntiBot] ${resolved.tag} ajouté à la whitelist globale dans ${jid}`);
  } catch (err) {
    console.error('Erreur handleAllowBotCommand:', err);
  }
}

/**
 * Commande .disallowbot / .delbot @user / number (Group Admins / Sudo)
 */
async function handleDisallowBotCommand(sock, jid, messageText, msg, senderIsAdmin, senderIsSudo) {
  try {
    if (!senderIsAdmin && !senderIsSudo) {
      return;
    }

    let targetUserId = extractTargetUser(messageText, msg);
    if (!targetUserId) {
      const words = messageText.trim().split(/\s+/);
      if (words[1]) {
        const num = words[1].replace(/[^0-9]/g, '');
        if (num.length >= 7) targetUserId = `${num}@s.whatsapp.net`;
      }
    }

    if (!targetUserId) {
      await sock.sendMessage(jid, { text: '❌ *يـرجـى تـحـديـد الـعـضـو* : *.disallowbot @عضو* أو *.disallowbot 212xxxxxxx*' });
      return;
    }

    const resolved = await resolveGroupParticipant(sock, jid, targetUserId, null);
    disallowBotUser(jid, resolved.phone);

    let text = `⎔⋅• ━ ╼━ ╼╃ ⌬〔 🚫 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
    text += `       🏰 *إمـبـراطـوريـة بـاراديـس* 🏰\n`;
    text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 🚫 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n\n`;
    text += `🚫 *تـم حـذفـه مـن الـقـائـمـة الـبـيـضـاء الـشـامـلـة (Global Whitelist)*\n\n`;
    text += `⋄ الـعـضـو : ${resolved.tag}\n`;
    text += `⋄ تـم إلـغـاء تـصـريـحـه فـي جـمـيـع الـمـجـمـوعـات.\n`;
    text += `⋄ سـيـتـم طـرده تـلـقـائـيـاً إذا اسـتـخـدم واتـسـاب مـرتـبـطـاً بـجـهـاز / بـوت ⚠️.\n\n`;
    text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚔️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
    text += `       🏰 *PARADIS EMPIRE* 🏰`;

    await sock.sendMessage(jid, { text, mentions: resolved.mentions });
    logActivity(`[AntiBot] ${resolved.tag} retiré de la whitelist globale dans ${jid}`);
  } catch (err) {
    console.error('Erreur handleDisallowBotCommand:', err);
  }
}

/**
 * Commande .allowedbots / .botwhitelist (Group Admins / Sudo / All)
 */
async function handleAllowedBotsListCommand(sock, jid, senderIsAdmin, senderIsSudo) {
  try {
    if (!senderIsAdmin && !senderIsSudo) {
      return;
    }

    const allowed = getAllowedBotUsers(jid);
    let text = `⎔⋅• ━ ╼━ ╼╃ ⌬〔 📋 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
    text += `       🏰 *إمـبـراطـوريـة بـاراديـس* 🏰\n`;
    text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 📋 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n\n`;
    text += `🛡️ *الـقـائـمـة الـبـيـضـاء الـشـامـلـة لـمـسـتـخـدمـي الـبـوت والـويـب (Global Whitelist)* 🛡️\n\n`;

    if (allowed.length === 0) {
      text += `⋄ لا يـوجـد أي عـضـو مـسـتـثـنـى حـالـيـاً.\n`;
      text += `⋄ لإضـافـة عـضـو : *.allowbot @عضو* أو *.allowbot 212xxxxxxx*\n\n`;
      text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚔️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
      text += `       🏰 *PARADIS EMPIRE* 🏰`;
      await sock.sendMessage(jid, { text });
      return;
    }

    text += `الأعـضـاء الـمـصـرح لـهـم بـاسـتـخـدام واتـسـاب ويـب / كـمـبـيـوتـر / بـوت فـي كـل الـمـجـمـوعـات :\n\n`;
    const mentions = [];
    allowed.forEach((u, i) => {
      const num = u.split('@')[0].split(':')[0];
      text += `${i + 1}️⃣ @${num} ↬ *مـصـرح عـالـمـيـاً* 🌐\n`;
      mentions.push(`${num}@s.whatsapp.net`);
    });

    text += `\n⋄ لإلـغـاء الـسـمـاح : *.disallowbot @عضو*\n\n`;
    text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚔️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
    text += `       🏰 *PARADIS EMPIRE* 🏰`;

    await sock.sendMessage(jid, { text, mentions });
  } catch (err) {
    console.error('Erreur handleAllowedBotsListCommand:', err);
  }
}

/**
 * Commande .allow @user / .allowuser @user (Sudo / Admins)
 * Autorise un utilisateur à utiliser le bot spécifiquement pour ce groupe
 */
async function handleAllowUserCommand(sock, jid, messageText, msg, senderIsAdmin, senderIsSudo) {
  try {
    if (!senderIsAdmin && !senderIsSudo) return;

    const targetUserId = extractTargetUser(messageText, msg);
    if (!targetUserId) {
      await sock.sendMessage(jid, {
        text: '❌ *يـرجـى تـحـديـد الـعـضـو* :\n⋄ قـم بـعـمـل مـنـشـن : *.allow @عضو*\n⋄ أو قـم بـالـرد عـلـى رسـالـتـه بـكـتـابـة *.allow*'
      });
      return;
    }

    const cleanPhone = String(targetUserId).split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
    addGroupAllowedUser(jid, cleanPhone);

    let text = `⎔⋅• ━ ╼━ ╼╃ ⌬〔 👤 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
    text += `       🏰 *إمـبـراطـوريـة بـاراديـس* 🏰\n`;
    text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 👤 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n\n`;
    text += `✅ *تـم الـسـمـاح لـلـعـضـو بـاسـتـخـدام أوامـر الـبـوت* ✅\n\n`;
    text += `⋄ الـعـضـو : @${cleanPhone}\n`;
    text += `⋄ الـنـطـاق : هـذه الـمـجـمـوعـة فـقـط 🏰\n`;
    text += `⋄ مـلاحـظـة : إذا غـادر الـبـوت هـذه الـمـجـمـوعـة، تـلـغـى الـصـلاحـيـة تـلـقـائـيـاً ⚠️.\n\n`;
    text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚔️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
    text += `       🏰 *PARADIS EMPIRE* 🏰`;

    await sock.sendMessage(jid, { text, mentions: [targetUserId] });
    logActivity(`[AllowUser] @${cleanPhone} autorisé dans ${jid}`);
  } catch (err) {
    console.error('Erreur handleAllowUserCommand:', err);
  }
}

/**
 * Commande .disallow @user / .deluser @user (Sudo / Admins)
 * Révoque l'autorisation d'un utilisateur dans ce groupe
 */
async function handleDisallowUserCommand(sock, jid, messageText, msg, senderIsAdmin, senderIsSudo) {
  try {
    if (!senderIsAdmin && !senderIsSudo) return;

    const targetUserId = extractTargetUser(messageText, msg);
    if (!targetUserId) {
      await sock.sendMessage(jid, {
        text: '❌ *يـرجـى تـحـديـد الـعـضـو* :\n⋄ قـم بـعـمـل مـنـشـن : *.disallow @عضو*\n⋄ أو قـم بـالـرد عـلـى رسـالـتـه بـكـتـابـة *.disallow*'
      });
      return;
    }

    const cleanPhone = String(targetUserId).split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
    removeGroupAllowedUser(jid, cleanPhone);

    let text = `⎔⋅• ━ ╼━ ╼╃ ⌬〔 🚫 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
    text += `       🏰 *إمـبـراطـوريـة بـاراديـس* 🏰\n`;
    text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 🚫 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n\n`;
    text += `🚫 *تـم إلـغـاء صـلاحـيـة اسـتـخـدام أوامـر الـبـوت* 🚫\n\n`;
    text += `⋄ الـعـضـو : @${cleanPhone}\n`;
    text += `⋄ لـم يـعـد بـإمـكـانـه اسـتـخـدام أوامـر الـبـوت فـي هـذه الـمـجـمـوعـة.\n\n`;
    text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚔️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
    text += `       🏰 *PARADIS EMPIRE* 🏰`;

    await sock.sendMessage(jid, { text, mentions: [targetUserId] });
    logActivity(`[DisallowUser] @${cleanPhone} révoqué dans ${jid}`);
  } catch (err) {
    console.error('Erreur handleDisallowUserCommand:', err);
  }
}

/**
 * Commande .allowedusers / .users / .المصرحين (Sudo / Admins)
 * Affiche la liste des membres autorisés dans ce groupe
 */
async function handleAllowedUsersListCommand(sock, jid, senderIsAdmin, senderIsSudo) {
  try {
    if (!senderIsAdmin && !senderIsSudo) return;

    const users = getGroupAllowedUsers(jid);
    let text = `⎔⋅• ━ ╼━ ╼╃ ⌬〔 📋 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
    text += `       🏰 *إمـبـراطـوريـة بـاراديـس* 🏰\n`;
    text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 📋 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n\n`;
    text += `📋 *قـائـمـة الأعـضـاء الـمـصـرح لـهـم بـاسـتـخـدام أوامـر الـبـوت* 📋\n`;
    text += `🏰 *الـنـطـاق* : هـذه الـمـجـمـوعـة فـقـط\n\n`;

    if (users.length === 0) {
      text += `⋄ لا يـوجـد أي عـضـو مـضـاف حـالـيـاً (الـسـودو مـصـرح لـهـم دائـمـاً) 🛡️\n\n`;
      text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚔️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
      text += `       🏰 *PARADIS EMPIRE* 🏰`;
      await sock.sendMessage(jid, { text });
      return;
    }

    const mentions = [];
    users.forEach((u, i) => {
      const phone = String(u).split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
      text += `${i + 1}️⃣ @${phone}\n`;
      mentions.push(`${phone}@s.whatsapp.net`);
    });

    text += `\n⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚔️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
    text += `       🏰 *PARADIS EMPIRE* 🏰`;

    await sock.sendMessage(jid, { text, mentions });
  } catch (err) {
    console.error('Erreur handleAllowedUsersListCommand:', err);
  }
}

/**
 * Commande .trust / .ثقة @user / number (Group Admins / Sudo)
 * Ajoute un numéro à la Whitelist Permanente Globale (Confiance 100%)
 * Ces numéros ne sont JAMAIS exclus à cause d'appareils liés (même avec 4 appareils)
 */
async function handleTrustCommand(sock, jid, messageText, msg, senderIsAdmin, senderIsSudo) {
  try {
    if (!senderIsAdmin && !senderIsSudo) {
      return;
    }

    let targetUserId = extractTargetUser(messageText, msg);
    if (!targetUserId) {
      const words = messageText.trim().split(/\s+/);
      if (words[1]) {
        const num = words[1].replace(/[^0-9]/g, '');
        if (num.length >= 7) targetUserId = `${num}@s.whatsapp.net`;
      }
    }

    if (!targetUserId) {
      await sock.sendMessage(jid, { 
        text: '❌ *يـرجـى تـحـديـد الـعـضـو* :\n⋄ قـم بـعـمـل مـنـشـن : *.trust @عضو*\n⋄ أو اكـتـب الـرقـم : *.trust 212xxxxxxx*\n⋄ أو قـم بـالـرد عـلـى رسـالـتـه بـكـتـابـة *.trust*' 
      });
      return;
    }

    const resolved = await resolveGroupParticipant(sock, jid, targetUserId, null);
    addPermanentWhitelist(resolved.phone);

    let text = `⎔⋅• ━ ╼━ ╼╃ ⌬〔 🌟 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
    text += `       🏰 *إمـبـراطـوريـة بـاراديـس* 🏰\n`;
    text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 🌟 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n\n`;
    text += `🌟 *تـمـت الإضـافـة إلـى الـقـائـمـة الـبـيـضـاء الـدائـمـة (ثـقـة 100%)* 🌟\n\n`;
    text += `⋄ الـعـضـو : ${resolved.tag}\n`;
    text += `⋄ الـحـالـة : مـوثـوق بـشـكـل دائـم فـي جـمـيـع الـمـجـمـوعـات 🛡️\n`;
    text += `⋄ لـن يـتـم طـرده أبـداً بـسـبـب ربـط الـحـسـاب (حـتـى لـو ربـط 4 أجـهـزة كـمـبـيـوتـر أو بـوت) ✅.\n\n`;
    text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚔️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
    text += `       🏰 *PARADIS EMPIRE* 🏰`;

    await sock.sendMessage(jid, { text, mentions: resolved.mentions });
    logActivity(`[PermanentWhitelist] ${resolved.tag} (${resolved.phone}) ajouté à la whitelist permanente`);
  } catch (err) {
    console.error('Erreur handleTrustCommand:', err);
  }
}

/**
 * Commande .untrust @user / number (Group Admins / Sudo)
 */
async function handleUntrustCommand(sock, jid, messageText, msg, senderIsAdmin, senderIsSudo) {
  try {
    if (!senderIsAdmin && !senderIsSudo) {
      return;
    }

    let targetUserId = extractTargetUser(messageText, msg);
    if (!targetUserId) {
      const words = messageText.trim().split(/\s+/);
      if (words[1]) {
        const num = words[1].replace(/[^0-9]/g, '');
        if (num.length >= 7) targetUserId = `${num}@s.whatsapp.net`;
      }
    }

    if (!targetUserId) {
      await sock.sendMessage(jid, { text: '❌ *يـرجـى تـحـديـد الـعـضـو* : *.untrust @عضو* أو *.untrust 212xxxxxxx*' });
      return;
    }

    const resolved = await resolveGroupParticipant(sock, jid, targetUserId, null);
    removePermanentWhitelist(resolved.phone);

    let text = `⎔⋅• ━ ╼━ ╼╃ ⌬〔 🚫 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
    text += `       🏰 *إمـبـراطـوريـة بـاراديـس* 🏰\n`;
    text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 🚫 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n\n`;
    text += `🚫 *تـم إلـغـاء الـثـقـة مـن الـقـائـمـة الـبـيـضـاء الـدائـمـة*\n\n`;
    text += `⋄ الـعـضـو : ${resolved.tag}\n`;
    text += `⋄ تـمـت إعـادتـه لـلـمـراقـبـة الـعـاديـة ضـد الـبـوتـات ⚠️.\n\n`;
    text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚔️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
    text += `       🏰 *PARADIS EMPIRE* 🏰`;

    await sock.sendMessage(jid, { text, mentions: resolved.mentions });
    logActivity(`[PermanentWhitelist] ${resolved.tag} (${resolved.phone}) retiré de la whitelist permanente`);
  } catch (err) {
    console.error('Erreur handleUntrustCommand:', err);
  }
}

/**
 * Commande .trustlist / .trusted (Group Admins / Sudo)
 * Affiche la liste des numéros ayant une confiance 100% permanente
 */
async function handleTrustListCommand(sock, jid) {
  try {
    const list = getPermanentWhitelist();
    let text = `⎔⋅• ━ ╼━ ╼╃ ⌬〔 🌟 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
    text += `       🏰 *إمـبـراطـوريـة بـاراديـس* 🏰\n`;
    text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 🌟 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n\n`;
    text += `🌟 *الـقـائـمـة الـبـيـضـاء الـدائـمـة (Confiance 100%)* 🌟\n\n`;
    text += `الأرقـام الـمـعـفـاة نـهـائـيـاً مـن طـرد الأجـهـزة الـمـرتـبـطـة والـبـوتـات :\n\n`;

    const mentions = [];
    list.forEach((num, i) => {
      text += `${i + 1}️⃣ @${num} ↬ 🛡️ *[ثـقـة 100% مـطـلـقـة]*\n`;
      mentions.push(`${num}@s.whatsapp.net`);
    });

    text += `\n⋄ لإضـافـة رقـم : *.trust 212xxxxxxx*\n`;
    text += `⋄ لإلـغـاء رقـم : *.untrust 212xxxxxxx*\n\n`;
    text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚔️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
    text += `       🏰 *PARADIS EMPIRE* 🏰`;

    await sock.sendMessage(jid, { text, mentions });
  } catch (err) {
    console.error('Erreur handleTrustListCommand:', err);
  }
}

/**
 * Parser d'indices pour les commandes .accept et .reject
 * Supporte: 1, 1 2, 1 2 5 8, 1,5 (plage 1 à 5), 1-5, all, الكل, a (premier candidat)
 */
function parseRequestIndices(argsString, totalRequests) {
  const raw = argsString.trim().toLowerCase();
  if (raw === 'all' || raw === 'الكل' || raw === 'tout') {
    return Array.from({ length: totalRequests }, (_, i) => i);
  }
  if (raw === 'a') {
    return totalRequests > 0 ? [0] : [];
  }

  const selectedIndices = new Set();
  const tokens = raw.split(/[\s]+/);

  for (const token of tokens) {
    if (token === 'a') {
      if (totalRequests >= 1) selectedIndices.add(0);
      continue;
    }

    // Plage comme "1,5" ou "1-5" ou "1..5"
    const rangeMatch = token.match(/^(\d+)[,\-.]+(\d+)$/);
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1], 10);
      const end = parseInt(rangeMatch[2], 10);
      const min = Math.min(start, end);
      const max = Math.max(start, end);
      for (let i = min; i <= max; i++) {
        if (i >= 1 && i <= totalRequests) {
          selectedIndices.add(i - 1);
        }
      }
      continue;
    }

    // Liste séparée par virgule "1,2,5"
    if (token.includes(',')) {
      const parts = token.split(',');
      for (const p of parts) {
        const num = parseInt(p.trim(), 10);
        if (!isNaN(num) && num >= 1 && num <= totalRequests) {
          selectedIndices.add(num - 1);
        }
      }
      continue;
    }

    // Nombre unique
    const num = parseInt(token, 10);
    if (!isNaN(num) && num >= 1 && num <= totalRequests) {
      selectedIndices.add(num - 1);
    }
  }

  return Array.from(selectedIndices).sort((a, b) => a - b);
}

const lastDisplayedRequests = new Map();

/**
 * Commande .requests (Group Admins / Sudo)
 * Scanne toutes les demandes d'adhésion en attente et affiche UNIQUEMENT
 * les comptes ayant des appareils connectés (linked devices / bots).
 */
async function handleJoinRequestsListCommand(sock, jid, senderIsAdmin = false, senderIsSudo = false) {
  try {
    if (!senderIsAdmin && !senderIsSudo) {
      return;
    }

    if (!isGroupMessage(jid)) {
      await sock.sendMessage(jid, { text: 'ℹ️ هذه العملية تعمل فقط داخل المجموعات.' });
      return;
    }

    if (typeof sock.groupRequestParticipantsList !== 'function') {
      await sock.sendMessage(jid, { text: '❌ مـيـزة طـلـبـات الانـضـمـام غـيـر مـدعـومـة فـي هـذا الإصـدار.' });
      return;
    }

    let currentGroupData = await getGroupDataSafely(sock, jid);
    if (!isBotAdmin(sock, currentGroupData)) {
      await sock.sendMessage(jid, { 
        text: '❌ *فـشـل الإجـراء* : يـجـب تـرقـيـة الـبـوت مـشـرفـاً (Admin) فـي الـمـجـمـوعـة لـعـرض وفـحـص طـلـبـات الانـضـمـام 🛡️' 
      });
      return;
    }

    const rawRequests = await sock.groupRequestParticipantsList(jid).catch(() => []);
    if (!rawRequests || rawRequests.length === 0) {
      lastDisplayedRequests.set(jid, []);
      let text = `⎔⋅• ━ ╼━ ╼╃ ⌬〔 📋 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
      text += `       🏰 *إمـبـراطـوريـة بـاراديـس* 🏰\n`;
      text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 📋 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n\n`;
      text += `📋 *طـلـبـات الانـضـمـام الـمـعـلـقـة* :\n\n`;
      text += `✨ لا تـوجـد أي طـلـبـات انـضـمـام مـعـلـقـة حـالـيـاً فـي هـذه الـمـجـمـوعـة.\n\n`;
      text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚔️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
      text += `       🏰 *PARADIS EMPIRE* 🏰`;
      await sock.sendMessage(jid, { text });
      return;
    }

    // Traitement et résolution des numéros pour tous les candidats
    const allParsedRequests = [];
    for (let i = 0; i < rawRequests.length; i++) {
      const req = rawRequests[i];
      const rawJid = req.jid || req.id || '';

      let phone = req.phone_number || req.phoneNumber || req.phone || req.user || req.sender_pn;
      if (phone) {
        phone = String(phone).split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
      }
      if (!phone) {
        phone = resolveRealPhoneNumber(rawJid);
      }
      if (!phone || phone.length > 15 || rawJid.endsWith('@lid')) {
        const usyncPhone = await resolveLidToPhoneViaUSync(sock, rawJid);
        if (usyncPhone) phone = usyncPhone;
      }
      if (!phone) {
        phone = (rawJid || '').split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
      }

      allParsedRequests.push({
        displayIndex: i + 1,
        rawReq: req,
        targetJid: rawJid,
        phone: phone
      });
    }

    lastDisplayedRequests.set(jid, allParsedRequests);

    // Scanner tous les candidats et filtrer UNIQUEMENT ceux ayant des linked devices
    const linkedDevicesRequests = [];
    for (let i = 0; i < allParsedRequests.length; i++) {
      const item = allParsedRequests[i];
      const check = await checkUserHasLinkedDevices(sock, item.targetJid || `${item.phone}@s.whatsapp.net`);
      const isBanned = isBannedUser(item.phone);
      const isPermanent = isPermanentWhitelisted(item.targetJid) || isPermanentWhitelisted(item.phone);
      const isWhitelisted = isPermanent || isBotAllowed(jid, item.targetJid) || isBotAllowed(jid, item.phone);

      const hasLinked = Boolean(check && (check.count > 0 || check.hasLinked));
      if (hasLinked) {
        linkedDevicesRequests.push({
          ...item,
          check,
          isBanned,
          isPermanent,
          isWhitelisted
        });
      }
    }

    // Si aucun compte avec linked devices n'est détecté
    if (linkedDevicesRequests.length === 0) {
      let text = `⎔⋅• ━ ╼━ ╼╃ ⌬〔 📋 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
      text += `       🏰 *إمـبـراطـوريـة بـاراديـس* 🏰\n`;
      text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 📋 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n\n`;
      text += `📥 *فـحـص طـلـبـات الانـضـمـام الـمـعـلـقـة* (${allParsedRequests.length}) :\n\n`;
      text += `✅ *لا يـوجـد أي حـسـاب مـرتـبـط بـأجـهـزة (Linked Devices / Bots) فـي طـلـبـات الانـضـمـام.*\n`;
      text += `📱 جـمـيـع الـطـلـبـات (${allParsedRequests.length}) هـي لـحـسـابـات هـاتـف عـاديـة (0 جـهـاز).\n\n`;
      text += `💡 *لـقـبـول كـل الـطـلـبـات* : *.accept all*\n`;
      text += `💡 *لـرفـض كـل الـطـلـبـات* : *.reject all*\n\n`;
      text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚔️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
      text += `       🏰 *PARADIS EMPIRE* 🏰`;
      await sock.sendMessage(jid, { text });
      return;
    }

    // Affichage UNIQUEMENT des comptes avec linked devices
    let text = `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚠️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
    text += `       🏰 *إمـبـراطـوريـة بـاراديـس* 🏰\n`;
    text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚠️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n\n`;
    text += `⚠️ *الـحـسـابـات الـمـرتـبـطـة بـأجـهـزة / بـوتـات (Linked Devices)* :\n`;
    text += `تـم كـشـف *${linkedDevicesRequests.length}* حـسـاب مـرتـبـط مـن أصـل *${allParsedRequests.length}* طـلـب مـعـلـق :\n\n`;

    const allMentions = [];

    for (let i = 0; i < linkedDevicesRequests.length; i++) {
      const item = linkedDevicesRequests[i];
      let badge = '';
      if (item.isBanned) {
        badge = '⛔ مـحـظـور (.ban)';
      } else if (item.isPermanent) {
        badge = `🤖 مـرتـبـط بـبـوت (${item.check.count} أجهزة) ↬ 🛡️ [ثقة 100%]`;
      } else if (item.isWhitelisted) {
        badge = `🤖 مـرتـبـط بـبـوت (${item.check.count} أجهزة) ↬ 🛡️ [مسموح]`;
      } else {
        badge = `⚠️ مـرتـبـط بـأجـهـزة (${item.check.count} أجهزة - بـوت/ويـب)`;
      }

      text += `*${item.displayIndex}.* +${item.phone} (@${item.phone})\n`;
      text += `   ⋄ الـحـالـة : ${badge}\n`;
      text += `   ⋄ قـبـول : *.accept ${item.displayIndex}* | رفـض : *.reject ${item.displayIndex}*\n\n`;

      allMentions.push(`${item.phone}@s.whatsapp.net`);
      if (item.targetJid && item.targetJid !== `${item.phone}@s.whatsapp.net`) {
        allMentions.push(item.targetJid);
      }
    }

    text += `──────────────────────\n`;
    text += `💡 *خـيـارات الـمـعـالـجـة* :\n`;
    text += `⋄ قـبـول طـلـب : *.accept <الرقم>* أو *.accept +<الهاتف>*\n`;
    text += `⋄ رفـض طـلـب : *.reject <الرقم>* أو *.reject +<الهاتف>*\n`;
    text += `⋄ قـبـول الـكـل : *.accept all*\n`;
    text += `⋄ رفـض الـكـل : *.reject all*\n\n`;
    text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚔️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
    text += `       🏰 *PARADIS EMPIRE SECURITY* 🏰`;

    await sock.sendMessage(jid, {
      text,
      mentions: Array.from(new Set(allMentions))
    });

  } catch (err) {
    console.error('Erreur handleJoinRequestsListCommand:', err);
    await sock.sendMessage(jid, { text: `❌ حـدث خـطـأ أثـنـاء جـلـب طـلـبـات الانـضـمـام: ${err.message}` });
  }
}

/**
 * Commande .accept / .reject avec support des indices (1, a, 1 2, 1,5, all) et numéros (+212...)
 */
async function handleJoinRequestActionCommand(sock, jid, messageText, action, senderIsAdmin, senderIsSudo) {
  try {
    if (!senderIsAdmin && !senderIsSudo) {
      return;
    }

    if (!isGroupMessage(jid)) {
      await sock.sendMessage(jid, { text: 'ℹ️ هذه العملية تعمل فقط داخل المجموعات.' });
      return;
    }

    let currentGroupData = await getGroupDataSafely(sock, jid);
    if (!isBotAdmin(sock, currentGroupData)) {
      await sock.sendMessage(jid, { 
        text: `❌ *فـشـل الإجـراء* : يـجـب تـرقـيـة الـبـوت مـشـرفـاً (Admin) فـي الـمـجـمـوعـة لـ${action === 'accept' ? 'قـبـول' : 'رفـض'} طـلـبـات الانـضـمـام 🛡️` 
      });
      return;
    }

    const words = messageText.trim().split(/\s+/);
    let rawArgs = words.slice(1).join(' ').trim();

    // Si l'utilisateur a écrit .accept+212... ou .reject+212... sans espace
    if (!rawArgs && words[0]) {
      const matchNoSpace = words[0].match(/^[.!/#]?(?:accept|reject|قبول|رفض|وافق)\+?([0-9a-zA-Z+]+)$/i);
      if (matchNoSpace) {
        rawArgs = matchNoSpace[1];
      }
    }

    const rawRequests = await sock.groupRequestParticipantsList(jid).catch(() => []);
    if (!rawRequests || rawRequests.length === 0) {
      lastDisplayedRequests.set(jid, []);
      await sock.sendMessage(jid, { text: 'ℹ️ لا تـوجـد أي طـلـبـات انـضـمـام مـعـلـقـة حـالـيـاً فـي هـذه الـمـجـمـوعـة.' });
      return;
    }

    // Résoudre tous les candidats disponibles
    const allParsedRequests = [];
    for (let i = 0; i < rawRequests.length; i++) {
      const req = rawRequests[i];
      const rawJid = req.jid || req.id || '';

      let phone = req.phone_number || req.phoneNumber || req.phone || req.user || req.sender_pn;
      if (phone) {
        phone = String(phone).split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
      }
      if (!phone) {
        phone = resolveRealPhoneNumber(rawJid);
      }
      if (!phone || phone.length > 15 || rawJid.endsWith('@lid')) {
        const usyncPhone = await resolveLidToPhoneViaUSync(sock, rawJid);
        if (usyncPhone) phone = usyncPhone;
      }
      if (!phone) {
        phone = (rawJid || '').split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
      }

      allParsedRequests.push({
        displayIndex: i + 1,
        rawReq: req,
        targetJid: rawJid,
        phone: phone
      });
    }

    const actType = (action === 'accept' || action === 'قبول' || action === 'وافق') ? 'approve' : 'reject';
    const actName = actType === 'approve' ? 'قـبـول' : 'رفـض';

    const jidsToProcess = [];
    const targetTags = [];
    const mentions = [];

    const displayed = lastDisplayedRequests.get(jid) || allParsedRequests;

    // Si aucun argument fourni :
    if (!rawArgs) {
      if (allParsedRequests.length === 1) {
        const item = allParsedRequests[0];
        jidsToProcess.push(item.targetJid);
        targetTags.push(`+${item.phone} (@${item.phone})`);
        mentions.push(item.targetJid, `${item.phone}@s.whatsapp.net`);
      } else {
        await sock.sendMessage(jid, { 
          text: `❌ *يـرجـى تـحـديـد الـطـلـب الـمـراد مـعـالـجـتـه* :\n\n` +
                `⋄ طـلـب مـحـدد : *.${action} 1*\n` +
                `⋄ بـالـرقـم الـمـبـاشـر : *.${action} +212xxxxxxx*\n` +
                `⋄ أرقـام مـتـعـددة : *.${action} 1 2 5*\n` +
                `⋄ جـمـيـع الـطـلـبـات : *.${action} all*` 
        });
        return;
      }
    } else {
      // 1. Vérifier si l'argument est un numéro de téléphone direct (ex: +2126xxxxxxxx ou 2126xxxxxxxx)
      const cleanDigits = rawArgs.replace(/[^0-9]/g, '');
      const isSinglePhoneNumber = cleanDigits.length >= 7 && !rawArgs.includes(',') && words.length <= 2;

      if (isSinglePhoneNumber) {
        const last9 = cleanDigits.length >= 9 ? cleanDigits.slice(-9) : cleanDigits;
        const found = allParsedRequests.find((r) => {
          return r.phone === cleanDigits || (r.phone && r.phone.endsWith(last9)) || (r.targetJid && r.targetJid.includes(cleanDigits));
        });

        if (found) {
          jidsToProcess.push(found.targetJid);
          targetTags.push(`+${found.phone} (@${found.phone})`);
          mentions.push(found.targetJid, `${found.phone}@s.whatsapp.net`);
        } else {
          await sock.sendMessage(jid, { 
            text: `❌ لـم يـتـم الـعـثـور عـلـى طـلـب انـضـمـام مـعـلـق لـلـرقـم : *+${cleanDigits}*\n\n📋 اكـتـب *.requests* لـعـرض كـافـة الـطـلـبـات الـمـعـلـقـة.` 
          });
          return;
        }
      } else {
        // 2. Traitement par indices (1, a, 1 2, 1,5, all, etc.)
        const sourceList = (displayed.length > 0) ? displayed : allParsedRequests;
        const selectedIndices = parseRequestIndices(rawArgs, sourceList.length);

        if (selectedIndices.length === 0) {
          await sock.sendMessage(jid, { 
            text: `❌ *لـم يـتـم الـعـثـور عـلـى أي طـلـب بـالـرقـم الـمـحـدد.* (الـطـلـبـات الـمـتـوفـرة مـن 1 إلـى ${sourceList.length})\n` +
                  `⋄ اكـتـب *.requests* لـعـرض قـائـمـة الـطـلـبـات والـتـرتـيـب.` 
          });
          return;
        }

        for (const idx of selectedIndices) {
          const item = sourceList[idx];
          if (!item) continue;

          jidsToProcess.push(item.targetJid);
          targetTags.push(`+${item.phone} (@${item.phone})`);
          mentions.push(item.targetJid, `${item.phone}@s.whatsapp.net`);
        }
      }
    }

    if (jidsToProcess.length === 0) {
      await sock.sendMessage(jid, { text: '❌ تـعـذر تـحـديـد أي طـلـب صـالـح لـلـمـعـالـجـة.' });
      return;
    }

    // Exécuter l'action sur WhatsApp
    await sock.groupRequestParticipantsUpdate(jid, jidsToProcess, actType);

    // Mettre à jour lastDisplayedRequests pour retirer les JIDs traités
    const remaining = allParsedRequests.filter((d) => !jidsToProcess.includes(d.targetJid));
    remaining.forEach((item, i) => { item.displayIndex = i + 1; });
    lastDisplayedRequests.set(jid, remaining);

    let text = `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ${actType === 'approve' ? '✅' : '❌'} 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
    text += `       🏰 *إمـبـراطـوريـة بـاراديـس* 🏰\n`;
    text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ${actType === 'approve' ? '✅' : '❌'} 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n\n`;
    text += `✅ *تـم ${actName} ${jidsToProcess.length} طـلـب(ات) انـضـمـام بـنـجـاح!*\n\n`;
    text += `⋄ الـعـدد الإجـمـالـي : *${jidsToProcess.length}*\n`;
    text += `⋄ الـحـسـابـات الـمـعـالـجـة : ${targetTags.join(' ، ')}\n`;
    text += `⋄ الإجـراء : ${actType === 'approve' ? 'تـم قـبـولـهـم وإضـافـتـهـم لـلـمـجـمـوعـة 🎉' : 'تـم رفـض طـلـب الانـضـمـام 🚫'}\n\n`;
    text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚔️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
    text += `       🏰 *PARADIS EMPIRE* 🏰`;

    await sock.sendMessage(jid, {
      text,
      mentions: Array.from(new Set(mentions))
    });

    logActivity(`[JoinRequests] ${actName} de ${jidsToProcess.length} demande(s) dans ${jid}`);
  } catch (err) {
    console.error('Erreur handleJoinRequestActionCommand:', err);
    await sock.sendMessage(jid, { text: `❌ تـعـذر تـنـفـيـذ الإجـراء: ${err.message}` });
  }
}

/**
 * Commande .reset / .revoke (Group Admins / Sudo)
 * Réinitialise et génère un nouveau lien d'invitation officiel pour le groupe
 */
async function handleResetInviteLinkCommand(sock, jid, senderIsAdmin, senderIsSudo) {
  try {
    if (!senderIsAdmin && !senderIsSudo) {
      return;
    }

    if (typeof sock.groupRevokeInvite !== 'function') {
      await sock.sendMessage(jid, { text: '❌ مـيـزة إعـادة تـعـيـيـن الـرابـط غـيـر مـدعـومـة.' });
      return;
    }

    const newCode = await sock.groupRevokeInvite(jid);
    if (!newCode) {
      await sock.sendMessage(jid, { text: '❌ تـعـذر تـجـديـد رابـط الـمـجـمـوعـة، تـأكـد مـن أن الـبـوت مـشـرف فـي الـمـجـمـوعـة.' });
      return;
    }

    const newInviteLink = `https://chat.whatsapp.com/${newCode}`;

    let text = `⎔⋅• ━ ╼━ ╼╃ ⌬〔 🔗 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
    text += `       🏰 *إمـبـراطـوريـة بـاراديـس* 🏰\n`;
    text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 🔄 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n\n`;
    text += `🔄 *تـم إعـادة تـعـيـيـن رابـط الـمـجـمـوعـة (Reset Link)* 🔄\n\n`;
    text += `⋄ تـم إلـغـاء وتـعـطـيـل الـرابـط الـقـديـم نـهـائـيـاً لـمـنـع الـدخـول غـيـر الـمـرغـوب 🚫.\n`;
    text += `⋄ الـرابـط الـرسـمـي الـجـديـد لـلـمـجـمـوعـة :\n`;
    text += `  📎 ${newInviteLink}\n\n`;
    text += `⎔⋅• ━ ╼━ ╼╃ ⌬〔 ⚔️ 〕⌬ ╄╾ ━ ╼━ •⋅⎔\n`;
    text += `       🏰 *PARADIS EMPIRE* 🏰`;

    await sock.sendMessage(jid, { text });
    logActivity(`[ResetInvite] Lien du groupe ${jid} réinitialisé: ${newInviteLink}`);
  } catch (err) {
    console.error('Erreur handleResetInviteLinkCommand:', err);
    await sock.sendMessage(jid, { text: `❌ تـعـذر إعـادة تـعـيـيـن الـرابـط: ${err.message}` });
  }
}

// ----------------------------------------------------
// Serveur Web Express & API Multi-Comptes
// ----------------------------------------------------

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ----------------------------------------------------
// Authentification & Sécurité Espace Admin (/admin)
// Login: JellalFernandez | Mdp: 120501
// ----------------------------------------------------

const ADMIN_CREDENTIALS = {
  username: 'JellalFernandez',
  password: '120501'
};

const adminTokens = new Map(); // token -> { username, loginTime }

function verifyAdminToken(req) {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7).trim()
    : req.headers['x-admin-token'] || req.query.token;

  if (token && adminTokens.has(token)) {
    return adminTokens.get(token);
  }
  return null;
}

// Page d'administration /admin demandée par l'utilisateur
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Redirection sécurisée des anciennes URL vers /admin
app.get('/comptes.html', (req, res) => res.redirect('/admin'));
app.get('/comptes', (req, res) => res.redirect('/admin'));

/**
 * API: Connexion Administrateur
 */
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body || {};
  if (username === ADMIN_CREDENTIALS.username && String(password) === ADMIN_CREDENTIALS.password) {
    const token = crypto.randomBytes(32).toString('hex');
    adminTokens.set(token, {
      username: ADMIN_CREDENTIALS.username,
      loginTime: Date.now()
    });
    logActivity(`[ADMIN] Connexion réussie de l'administrateur ${username}`, 'system');
    return res.json({
      success: true,
      token,
      username: ADMIN_CREDENTIALS.username
    });
  }
  logActivity(`[ADMIN] Échec de connexion avec le login "${username}"`, 'warn');
  return res.status(401).json({
    success: false,
    error: 'Identifiant ou mot de passe incorrect.'
  });
});

/**
 * API: Déconnexion Administrateur
 */
app.post('/api/admin/logout', (req, res) => {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7).trim()
    : req.headers['x-admin-token'] || req.body?.token;
  if (token) {
    adminTokens.delete(token);
  }
  res.json({ success: true, message: 'Déconnecté avec succès.' });
});

/**
 * API: Vérifier validité du token admin
 */
app.get('/api/admin/verify', (req, res) => {
  const session = verifyAdminToken(req);
  if (session) {
    return res.json({ success: true, username: session.username });
  }
  return res.status(401).json({ success: false, error: 'Session expirée ou non autorisée.' });
});

/**
 * API: Liste des comptes protégée pour l'interface Admin
 */
app.get('/api/admin/accounts', async (req, res) => {
  if (!verifyAdminToken(req)) {
    return res.status(401).json({ success: false, error: 'Accès non autorisé. Veuillez vous connecter.' });
  }
  try {
    const accounts = await getAllAccountsData();
    res.json({ success: true, accounts });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * API: Forcer la déconnexion d'un utilisateur / compte WhatsApp
 */
app.post('/api/admin/disconnect', async (req, res) => {
  if (!verifyAdminToken(req)) {
    return res.status(401).json({ success: false, error: 'Accès non autorisé.' });
  }
  try {
    const { phoneNumber } = req.body || {};
    const cleanPhone = String(phoneNumber || '').replace(/[^0-9]/g, '');

    if (!cleanPhone) {
      return res.status(400).json({ success: false, error: 'Numéro de téléphone requis.' });
    }

    logActivity(`[ADMIN] Déconnexion FORCÉE demandée pour le compte +${cleanPhone}...`, 'warn');

    const session = sessions.get(cleanPhone);
    if (session?.sock) {
      try { await session.sock.logout(); } catch (_) {}
      try { session.sock.ev.removeAllListeners(); session.sock.ws?.close(); } catch (_) {}
    }

    // Supprimer définitivement le dossier de session pour ce numéro
    const sDir = path.join(SESSIONS_BASE_DIR, cleanPhone);
    if (fs.existsSync(sDir)) {
      try { fs.rmSync(sDir, { recursive: true, force: true }); } catch (_) {}
    }

    sessions.delete(cleanPhone);
    logActivity(`[ADMIN] Compte +${cleanPhone} déconnecté de force et supprimé du serveur avec succès.`, 'system');
    broadcastSSE({ type: 'session_deleted', phone: cleanPhone });

    res.json({
      success: true,
      message: `Le compte +${cleanPhone} a été déconnecté de force avec succès.`
    });
  } catch (error) {
    console.error('Erreur déconnexion forcée admin:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

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
 * Scanner d'arrière-plan automatique pour détecter les membres déjà dans le groupe
 * qui lient leur WhatsApp à un bot ou un PC ultérieurement.
 * Tourne toutes les 45 secondes de façon fluide et sécurisée (anti-ban).
 */
let periodicScanInterval = null;
function startPeriodicAntiBotScanner() {
  if (periodicScanInterval) return;
  logActivity('🛡️ Scanner périodique Anti-Bot en arrière-plan activé.');

  periodicScanInterval = setInterval(async () => {
    try {
      for (const [phone, sess] of sessions.entries()) {
        if (sess.status !== 'connected' || !sess.sock) continue;
        const sock = sess.sock;
        const botNumber = (sock.user?.id || '').split('@')[0].split(':')[0];

        let groups = [];
        try {
          if (typeof sock.groupFetchAllParticipating === 'function') {
            const participating = await sock.groupFetchAllParticipating();
            groups = Object.values(participating);
          }
        } catch (_) {}

        for (const group of groups) {
          const jid = group.id;
          if (!jid) continue;

          const participants = group.participants || [];
          if (!participants || participants.length === 0) continue;

          // 1. Vérification et purge Blacklist dans TOUS les groupes (avec gestion bot admin / non-admin et rétrogradation si cible admin)
          await checkAndPurgeBlacklistInGroup(sock, jid, group);

          // 2. Vérification Anti-Bot (appareils liés) uniquement si activé
          if (!isAntiBotEnabled(jid)) continue;

          const candidates = [];
          const phoneToPart = new Map();

          for (const p of participants) {
            let cleanPhone = null;
            if (p.jid && p.jid.endsWith('@s.whatsapp.net')) {
              cleanPhone = p.jid.split('@')[0].split(':')[0];
            } else if (p.id && p.id.endsWith('@s.whatsapp.net')) {
              cleanPhone = p.id.split('@')[0].split(':')[0];
            } else if (p.phoneNumber) {
              cleanPhone = String(p.phoneNumber).replace(/[^0-9]/g, '');
            } else {
              cleanPhone = resolveRealPhoneNumber(p.id || p.jid);
            }

            if (!cleanPhone || cleanPhone === botNumber || isSelfUser(sock, cleanPhone)) continue;
            if (isSudo(cleanPhone) || isSudo(p.id || p.jid)) continue;
            if (isPermanentWhitelisted(cleanPhone) || isPermanentWhitelisted(p.id || p.jid)) continue;
            if (isBotAllowed(jid, cleanPhone) || isBotAllowed(jid, p.id || p.jid)) continue;
            if (isBannedUser(cleanPhone) || isBannedUser(p.id || p.jid) || isNumberBlacklisted(cleanPhone) || isNumberBlacklisted(p.id || p.jid)) continue;

            const standardJid = `${cleanPhone}@s.whatsapp.net`;
            candidates.push(standardJid);
            phoneToPart.set(cleanPhone, p);
          }

          if (candidates.length === 0) continue;

          // Lots de 25 avec sock.getUSyncDevices (instantané et identique à .scan)
          const detectedInGroup = [];
          const chunkSize = 25;

          for (let i = 0; i < candidates.length; i += chunkSize) {
            const batch = candidates.slice(i, i + chunkSize);
            try {
              if (typeof sock.getUSyncDevices === 'function') {
                const devices = await sock.getUSyncDevices(batch, false, false);
                if (Array.isArray(devices)) {
                  for (const dev of devices) {
                    const devId = Number(dev.device);
                    if (!isNaN(devId) && devId > 0) {
                      const userPhone = String(dev.user || '').replace(/[^0-9]/g, '');
                      if (!userPhone || userPhone === botNumber || isSelfUser(sock, userPhone)) continue;
                      if (isSudo(userPhone) || isPermanentWhitelisted(userPhone) || isBotAllowed(jid, userPhone)) continue;

                      const part = phoneToPart.get(userPhone);
                      const targetId = part ? (part.id || part.jid || `${userPhone}@s.whatsapp.net`) : `${userPhone}@s.whatsapp.net`;
                      if (!detectedInGroup.includes(targetId)) {
                        detectedInGroup.push(targetId);
                        logActivity(`[Radar-AntiBot] Appareil lié détecté pour @${userPhone} dans ${jid}`, 'warn');
                      }
                    }
                  }
                }
              }
            } catch (_) {}
          }

          if (detectedInGroup.length > 0) {
            logActivity(`[Radar-AntiBot] Déclenchement procédure d'expulsion pour ${detectedInGroup.length} membre(s) dans ${jid} !`, 'warn');
            await executeAntiBotBatchProcedure(sock, jid, detectedInGroup, group);
          }
        }
      }
    } catch (err) {
      // Ignorer erreurs silencieuses du scanner
    }
  }, 20000);
}

/**
 * Démarrage du serveur et reconnexion automatique de toutes les sessions enregistrées
 */
async function startServer() {
  try {
    // 1. Initialiser la base SQLite
    db = await initializeDatabase();

    // 2. Migrer l'ancienne session si elle existe
    migrateLegacySession();

    // 2.5 Lancer le scanner automatique d'arrière-plan
    startPeriodicAntiBotScanner();

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
