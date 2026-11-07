import initSqlJs from 'sql.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATABASE_PATH = path.join(__dirname, 'botdata.db');

const DEFAULT_BANNED_TABNEED = [
  '9647801266024',
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
];

let db = null;
let SQL = null;
const memorySettings = new Map();
const bannedUsersCache = new Set(DEFAULT_BANNED_TABNEED);

/**
 * Normaliser un ID de groupe WhatsApp (supprime :0, :1, etc.)
 */
export function cleanGroupId(groupId) {
  if (!groupId) return '';
  const num = String(groupId).split('@')[0].split(':')[0].replace(/[^0-9_\-]/g, '');
  return `${num}@g.us`;
}

/**
 * Initialiser la base de données SQLite et créer les tables nécessaires
 */
export async function initializeDatabase() {
  try {
    SQL = await initSqlJs();

    let data;
    if (fs.existsSync(DATABASE_PATH)) {
      data = fs.readFileSync(DATABASE_PATH);
    } else {
      data = null;
    }

    db = data ? new SQL.Database(data) : new SQL.Database();

    // 1. Table des avertissements (warnings)
    db.run(`
      CREATE TABLE IF NOT EXISTS warnings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        groupId TEXT NOT NULL,
        userId TEXT NOT NULL,
        count INTEGER DEFAULT 0,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(groupId, userId)
      )
    `);

    // 2. Table des paramètres globaux (mode public/private, etc.)
    db.run(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
      )
    `);

    // 3. Table des utilisateurs Sudo (autorisés à utiliser le bot en mode private)
    db.run(`
      CREATE TABLE IF NOT EXISTS sudos (
        userId TEXT PRIMARY KEY,
        addedAt DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 4. Table des utilisateurs autorisés à envoyer des liens (Whitelist liens)
    db.run(`
      CREATE TABLE IF NOT EXISTS allowed_links (
        groupId TEXT NOT NULL,
        userId TEXT NOT NULL,
        addedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY(groupId, userId)
      )
    `);

    // 5. Table des utilisateurs autorisés à utiliser un appareil lié/bot (Whitelist Anti-Bot)
    db.run(`
      CREATE TABLE IF NOT EXISTS allowed_bots (
        groupId TEXT NOT NULL,
        userId TEXT NOT NULL,
        addedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY(groupId, userId)
      )
    `);

    // 6. Table de la Whitelist Permanente Globale (Confiance 100% Anti-Bot)
    db.run(`
      CREATE TABLE IF NOT EXISTS permanent_whitelist (
        phone TEXT PRIMARY KEY,
        addedAt DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 7. Table des utilisateurs autorisés par groupe en Mode Privé
    db.run(`
      CREATE TABLE IF NOT EXISTS group_allowed_users (
        groupId TEXT NOT NULL,
        userId TEXT NOT NULL,
        addedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY(groupId, userId)
      )
    `);

    // 8. Table des utilisateurs bannis globalement (.ban - blacklist anti-spam)
    db.run(`
      CREATE TABLE IF NOT EXISTS banned_users (
        phone TEXT PRIMARY KEY,
        addedAt DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Nettoyer les comptes non-sudo s'ils avaient été ajoutés dans la table sudos
    db.run(`DELETE FROM sudos WHERE userId LIKE '%212603125628%' OR userId LIKE '%212781848716%' OR userId LIKE '%212767016197%' OR userId LIKE '%212771313350%'`);

    // Insérer les numéros de confiance permanente (trusted linked devices - 100% immune)
    db.run(`INSERT OR IGNORE INTO permanent_whitelist (phone) VALUES ('212781848716')`);
    db.run(`INSERT OR IGNORE INTO permanent_whitelist (phone) VALUES ('212603125628')`);
    db.run(`INSERT OR IGNORE INTO permanent_whitelist (phone) VALUES ('212767016197')`);
    db.run(`INSERT OR IGNORE INTO permanent_whitelist (phone) VALUES ('212771313350')`);

    // Enregistrer automatiquement tous les SUDOS permanents dans la table sudos
    for (const p of PERMANENT_SUDOS) {
      db.run('INSERT OR IGNORE INTO sudos (userId) VALUES (?)', [`${p}@s.whatsapp.net`]);
      db.run('INSERT OR IGNORE INTO sudos (userId) VALUES (?)', [p]);
    }

    // Charger les paramètres en mémoire vive (cache 0ms)
    try {
      const res = db.exec('SELECT key, value FROM settings');
      if (res.length > 0 && res[0].values) {
        for (const [k, v] of res[0].values) {
          memorySettings.set(k, String(v));
        }
      }
    } catch (_) {}

    // Charger les utilisateurs bannis en mémoire vive (cache 0ms)
    try {
      const bRes = db.exec('SELECT phone FROM banned_users');
      if (bRes.length > 0 && bRes[0].values) {
        for (const [phone] of bRes[0].values) {
          bannedUsersCache.add(String(phone));
        }
      }
    } catch (_) {}

    // Insérer automatiquement les numéros d'attaque tabneed/spam dans la blacklist globale
    const DEFAULT_BANNED_TABNEED = [
      '9647801266024',
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
    ];
    for (const b of DEFAULT_BANNED_TABNEED) {
      db.run('INSERT OR IGNORE INTO banned_users (phone) VALUES (?)', [b]);
      bannedUsersCache.add(b);
    }

    saveDatabase();
    console.log('✅ Base de données initialisée avec succès (tables warnings, settings, sudos, allowed_links, allowed_bots, permanent_whitelist, group_allowed_users, banned_users)');
    return db;
  } catch (error) {
    console.error('❌ Erreur lors de l\'initialisation de la base de données:', error);
    process.exit(1);
  }
}

/**
 * Sauvegarder la base de données dans le fichier
 */
function saveDatabase() {
  if (db) {
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(DATABASE_PATH, buffer);
  }
}

/**
 * Ajouter un warning à un utilisateur (ou augmenter le compte +1)
 */
export function addWarning(groupId, userId, alternativeIds = []) {
  try {
    const primaryId = String(userId || '').split('@')[0].split(':')[0];
    const currentCount = getWarningCount(groupId, userId, alternativeIds);
    const newCount = currentCount + 1;

    // Nettoyer les anciens enregistrements sous d'autres formes (LID, @s.whatsapp.net)
    resetWarnings(groupId, userId, alternativeIds);

    // Insérer le nouveau compte sous l'ID primaire normalisé
    db.run(
      'INSERT INTO warnings (groupId, userId, count) VALUES (?, ?, ?)',
      [groupId, primaryId, newCount]
    );
    saveDatabase();
    return newCount;
  } catch (error) {
    console.error('❌ Erreur lors de l\'ajout d\'un warning:', error);
    return 0;
  }
}

/**
 * Récupérer le nombre de warnings d'un utilisateur (supporte JID, LID et numéro de téléphone)
 */
export function getWarningCount(groupId, userId, alternativeIds = []) {
  try {
    const rawIds = [userId, ...(Array.isArray(alternativeIds) ? alternativeIds : [])].filter(Boolean);
    const ids = Array.from(new Set(rawIds.flatMap(id => {
      const clean = String(id).split('@')[0].split(':')[0];
      return [id, clean, `${clean}@s.whatsapp.net`];
    })));

    const placeholders = ids.map(() => '?').join(', ');
    const result = db.exec(
      `SELECT MAX(count) FROM warnings WHERE groupId = ? AND userId IN (${placeholders})`,
      [groupId, ...ids]
    );

    if (result.length > 0 && result[0].values.length > 0 && result[0].values[0][0] !== null) {
      return result[0].values[0][0];
    }
    return 0;
  } catch (error) {
    console.error('❌ Erreur lors de la récupération des warnings:', error);
    return 0;
  }
}

/**
 * Réinitialiser les warnings d'un utilisateur
 */
export function resetWarnings(groupId, userId, alternativeIds = []) {
  try {
    const rawIds = [userId, ...(Array.isArray(alternativeIds) ? alternativeIds : [])].filter(Boolean);
    const ids = Array.from(new Set(rawIds.flatMap(id => {
      const clean = String(id).split('@')[0].split(':')[0];
      return [id, clean, `${clean}@s.whatsapp.net`];
    })));

    const placeholders = ids.map(() => '?').join(', ');
    db.run(
      `DELETE FROM warnings WHERE groupId = ? AND userId IN (${placeholders})`,
      [groupId, ...ids]
    );
    saveDatabase();
    console.log(`✅ Warnings réinitialisés pour l'utilisateur ${userId}`);
  } catch (error) {
    console.error('❌ Erreur lors de la réinitialisation des warnings:', error);
  }
}

/**
 * Récupérer tous les warnings d'un groupe
 */
export function getGroupWarnings(groupId) {
  try {
    const result = db.exec(
      'SELECT * FROM warnings WHERE groupId = ? ORDER BY count DESC',
      [groupId]
    );

    if (result.length > 0) {
      const warnings = [];
      result[0].values.forEach((row) => {
        warnings.push({
          id: row[0],
          groupId: row[1],
          userId: row[2],
          count: row[3],
          createdAt: row[4],
          updatedAt: row[5],
        });
      });
      return warnings;
    }
    return [];
  } catch (error) {
    console.error('❌ Erreur lors de la récupération des warnings du groupe:', error);
    return [];
  }
}

// ----------------------------------------------------
// Gestion des paramètres (Mode Public / Private)
// ----------------------------------------------------

export function getSetting(key, defaultValue = null) {
  try {
    if (memorySettings.has(key)) {
      return memorySettings.get(key);
    }
    const result = db.exec('SELECT value FROM settings WHERE key = ?', [key]);
    if (result.length > 0 && result[0].values.length > 0) {
      const val = result[0].values[0][0];
      memorySettings.set(key, String(val));
      return val;
    }
    return defaultValue;
  } catch (error) {
    console.error('❌ Erreur getSetting:', error);
    return defaultValue;
  }
}

export function setSetting(key, value) {
  try {
    const strVal = String(value);
    memorySettings.set(key, strVal);
    db.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [key, strVal]);
    saveDatabase();
    return true;
  } catch (error) {
    console.error('❌ Erreur setSetting:', error);
    return false;
  }
}

export function getGroupBotMode(groupId) {
  if (!groupId) return 'private';
  const cleanId = cleanGroupId(groupId);
  return getSetting(`mode_${cleanId}`, 'private');
}

export function setGroupBotMode(groupId, mode) {
  if (!groupId) return false;
  const cleanId = cleanGroupId(groupId);
  const cleanMode = mode === 'public' ? 'public' : 'private';
  return setSetting(`mode_${cleanId}`, cleanMode);
}

export function getBotMode(groupId = null) {
  if (groupId) return getGroupBotMode(groupId);
  return getSetting('bot_mode', 'private');
}

export function setBotMode(mode, groupId = null) {
  if (groupId) return setGroupBotMode(groupId, mode);
  const cleanMode = mode === 'public' ? 'public' : 'private';
  return setSetting('bot_mode', cleanMode);
}

// ----------------------------------------------------
// Liste des SUDO Permanents (Infaillibles et Indestructibles)
// Ces numéros ont l'accès absolu au bot et ne peuvent jamais être supprimés
// ----------------------------------------------------
export const PERMANENT_SUDOS = new Set([
  '212626623000',
  '212610316457',
  '212604934161',
  '212626388283',
  '212709439701',
  '212760132580',
  '212712974718',
  '212626297553',
  '212717716959',
  '212647385179',
  '212775395922',
  '212701645211',
  '212602002819',
  '212656476122',
  '212671308553',
  '212677071443',
  '9647834469120',
  '212677380188',
  '212716922340',
  '212625415608',
  '212701144271',
  '212601393396',
  '212627974926',
  '2126998917192',
  '212699891719',
  '212699917192'
]);

// ----------------------------------------------------
// Gestion des utilisateurs SUDO
// ----------------------------------------------------

export function isSudo(userId) {
  try {
    if (!userId) return false;
    const cleanPhone = String(userId).split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
    if (!cleanPhone) return false;

    // Numéros explicitement non-sudo (uniquement trusted linked devices - simples utilisateurs)
    if (cleanPhone === '212603125628' || cleanPhone.endsWith('603125628')) return false;
    if (cleanPhone === '212781848716' || cleanPhone.endsWith('781848716')) return false;
    if (cleanPhone === '212767016197' || cleanPhone.endsWith('767016197')) return false;
    if (cleanPhone === '212771313350' || cleanPhone.endsWith('771313350')) return false;

    if (PERMANENT_SUDOS.has(cleanPhone)) return true;

    // Correspondance flexible (ex: 06... vs 2126... ou 601393396 vs 212601393396)
    if (cleanPhone.length >= 9) {
      const last9 = cleanPhone.slice(-9);
      for (const p of PERMANENT_SUDOS) {
        if (p.slice(-9) === last9) return true;
      }
    }

    if (!db) return false;
    const cleanUser = `${cleanPhone}@s.whatsapp.net`;
    const result = db.exec('SELECT userId FROM sudos WHERE userId = ? OR userId = ?', [cleanUser, cleanPhone]);
    return result.length > 0 && result[0].values.length > 0;
  } catch (error) {
    console.error('❌ Erreur isSudo:', error);
    return false;
  }
}

export function addSudo(userId) {
  try {
    if (!userId) return false;
    const cleanPhone = String(userId).split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
    if (!cleanPhone) return false;

    // Ne jamais ajouter les comptes réservés comme whitelist-only aux sudos
    if (cleanPhone === '212603125628' || cleanPhone === '212781848716' || cleanPhone === '212767016197' || cleanPhone === '212771313350') return false;

    if (PERMANENT_SUDOS.has(cleanPhone)) return true;

    const cleanUser = `${cleanPhone}@s.whatsapp.net`;
    db.run('INSERT OR IGNORE INTO sudos (userId) VALUES (?)', [cleanUser]);
    saveDatabase();
    return true;
  } catch (error) {
    console.error('❌ Erreur addSudo:', error);
    return false;
  }
}

export function removeSudo(userId) {
  try {
    if (!userId) return false;
    const cleanPhone = String(userId).split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
    if (PERMANENT_SUDOS.has(cleanPhone)) {
      // Les SUDO permanents ne peuvent pas être supprimés par commande
      return false;
    }
    const cleanUser = `${cleanPhone}@s.whatsapp.net`;
    db.run('DELETE FROM sudos WHERE userId = ? OR userId = ?', [cleanUser, cleanPhone]);
    saveDatabase();
    return true;
  } catch (error) {
    console.error('❌ Erreur removeSudo:', error);
    return false;
  }
}

export function getSudoList() {
  try {
    const list = new Set(Array.from(PERMANENT_SUDOS).map(p => `${p}@s.whatsapp.net`));
    if (db) {
      const result = db.exec('SELECT userId FROM sudos ORDER BY addedAt ASC');
      if (result.length > 0 && result[0].values.length > 0) {
        for (const v of result[0].values) {
          const cleanPhone = String(v[0]).split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
          if (cleanPhone && cleanPhone !== '212603125628' && cleanPhone !== '212781848716' && cleanPhone !== '212767016197' && cleanPhone !== '212771313350') {
            list.add(`${cleanPhone}@s.whatsapp.net`);
          }
        }
      }
    }
    return Array.from(list);
  } catch (error) {
    console.error('❌ Erreur getSudoList:', error);
    return Array.from(PERMANENT_SUDOS).map(p => `${p}@s.whatsapp.net`);
  }
}

// ----------------------------------------------------
// Gestion des utilisateurs autorisés par groupe (Group-Scoped Allowed Users)
// Permissions spécifiques au groupe : si le bot quitte le groupe, elles sont révoquées
// ----------------------------------------------------

export function addGroupAllowedUser(groupId, userId) {
  try {
    if (!groupId || !userId) return false;
    const cleanId = cleanGroupId(groupId);
    const cleanPhone = String(userId).split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
    if (!cleanPhone) return false;
    const cleanUser = `${cleanPhone}@s.whatsapp.net`;
    db.run('INSERT OR IGNORE INTO group_allowed_users (groupId, userId) VALUES (?, ?)', [cleanId, cleanUser]);
    saveDatabase();
    return true;
  } catch (error) {
    console.error('❌ Erreur addGroupAllowedUser:', error);
    return false;
  }
}

export function removeGroupAllowedUser(groupId, userId) {
  try {
    if (!groupId || !userId) return false;
    const cleanId = cleanGroupId(groupId);
    const cleanPhone = String(userId).split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
    if (!cleanPhone) return false;
    const cleanUser = `${cleanPhone}@s.whatsapp.net`;
    db.run('DELETE FROM group_allowed_users WHERE groupId = ? AND (userId = ? OR userId = ?)', [cleanId, cleanUser, cleanPhone]);
    saveDatabase();
    return true;
  } catch (error) {
    console.error('❌ Erreur removeGroupAllowedUser:', error);
    return false;
  }
}

export function isGroupAllowedUser(groupId, userId) {
  try {
    if (!groupId || !userId) return false;
    const cleanId = cleanGroupId(groupId);
    const cleanPhone = String(userId).split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
    if (!cleanPhone) return false;
    const cleanUser = `${cleanPhone}@s.whatsapp.net`;
    const result = db.exec('SELECT userId FROM group_allowed_users WHERE groupId = ? AND (userId = ? OR userId = ?)', [cleanId, cleanUser, cleanPhone]);
    return result.length > 0 && result[0].values.length > 0;
  } catch (error) {
    console.error('❌ Erreur isGroupAllowedUser:', error);
    return false;
  }
}

export function getGroupAllowedUsers(groupId) {
  try {
    if (!groupId) return [];
    const cleanId = cleanGroupId(groupId);
    const result = db.exec('SELECT userId FROM group_allowed_users WHERE groupId = ? ORDER BY addedAt ASC', [cleanId]);
    if (result.length > 0 && result[0].values.length > 0) {
      return result[0].values.map(v => v[0]);
    }
    return [];
  } catch (error) {
    console.error('❌ Erreur getGroupAllowedUsers:', error);
    return [];
  }
}

export function clearGroupAllowedUsers(groupId) {
  try {
    if (!groupId) return false;
    const cleanId = cleanGroupId(groupId);
    db.run('DELETE FROM group_allowed_users WHERE groupId = ?', [cleanId]);
    saveDatabase();
    return true;
  } catch (error) {
    console.error('❌ Erreur clearGroupAllowedUsers:', error);
    return false;
  }
}

// ----------------------------------------------------
// Gestion de l'Anti-Link et Liste Blanche (Allowed Links)
// ----------------------------------------------------

export function isAntiLinkEnabled(groupId) {
  try {
    if (!groupId) return true;
    const cleanId = cleanGroupId(groupId);
    const val = getSetting(`antilink_${cleanId}`, 'on');
    return val !== 'off';
  } catch (error) {
    return true;
  }
}

export function setAntiLinkEnabled(groupId, enabled) {
  const cleanId = cleanGroupId(groupId);
  return setSetting(`antilink_${cleanId}`, enabled ? 'on' : 'off');
}

export function allowLinkUser(groupId, userId) {
  try {
    if (!groupId || !userId) return false;
    const cleanId = cleanGroupId(groupId);
    const cleanUser = userId.split('@')[0].split(':')[0] + '@s.whatsapp.net';
    db.run('INSERT OR IGNORE INTO allowed_links (groupId, userId) VALUES (?, ?)', [cleanId, cleanUser]);
    saveDatabase();
    return true;
  } catch (error) {
    console.error('❌ Erreur allowLinkUser:', error);
    return false;
  }
}

export function disallowLinkUser(groupId, userId) {
  try {
    if (!groupId || !userId) return false;
    const cleanId = cleanGroupId(groupId);
    const cleanUser = userId.split('@')[0].split(':')[0] + '@s.whatsapp.net';
    db.run('DELETE FROM allowed_links WHERE groupId = ? AND userId = ?', [cleanId, cleanUser]);
    saveDatabase();
    return true;
  } catch (error) {
    console.error('❌ Erreur disallowLinkUser:', error);
    return false;
  }
}

export function isLinkAllowed(groupId, userId) {
  try {
    if (!groupId || !userId) return false;
    const cleanId = cleanGroupId(groupId);
    const cleanUser = userId.split('@')[0].split(':')[0] + '@s.whatsapp.net';
    const result = db.exec('SELECT userId FROM allowed_links WHERE groupId = ? AND userId = ?', [cleanId, cleanUser]);
    return result.length > 0 && result[0].values.length > 0;
  } catch (error) {
    console.error('❌ Erreur isLinkAllowed:', error);
    return false;
  }
}

export function getAllowedLinkUsers(groupId) {
  try {
    if (!groupId) return [];
    const cleanId = cleanGroupId(groupId);
    const result = db.exec('SELECT userId FROM allowed_links WHERE groupId = ? ORDER BY addedAt ASC', [cleanId]);
    if (result.length > 0 && result[0].values.length > 0) {
      return result[0].values.map(v => v[0]);
    }
    return [];
  } catch (error) {
    console.error('❌ Erreur getAllowedLinkUsers:', error);
    return [];
  }
}

// ----------------------------------------------------
// Gestion de l'Anti-Bot (Détection des appareils liés / bots)
// ----------------------------------------------------

export function isAntiBotEnabled(groupId) {
  try {
    if (!groupId) return false;
    const cleanId = cleanGroupId(groupId);
    const val = getSetting(`antibot_${cleanId}`, 'off');
    return val === 'on';
  } catch (error) {
    return false;
  }
}

export function setAntiBotEnabled(groupId, enabled) {
  const cleanId = cleanGroupId(groupId);
  return setSetting(`antibot_${cleanId}`, enabled ? 'on' : 'off');
}

// ----------------------------------------------------
// Paramètres Anti-Spam (Transfert de messages successifs)
// ----------------------------------------------------

export function isAntiSpamEnabled(groupId) {
  try {
    if (!groupId) return false;
    const cleanId = cleanGroupId(groupId);
    const val = getSetting(`antispam_${cleanId}`, 'off');
    return val === 'on';
  } catch (error) {
    return false;
  }
}

export function setAntiSpamEnabled(groupId, enabled) {
  const cleanId = cleanGroupId(groupId);
  return setSetting(`antispam_${cleanId}`, enabled ? 'on' : 'off');
}

// ----------------------------------------------------
// Paramètres Anti-Spam Add (Flood d'ajouts de membres / Tabneed)
// Activé uniquement si demandé (par défaut: off)
// ----------------------------------------------------

export function isAntiSpamAddEnabled(groupId) {
  try {
    if (!groupId) return false;
    const cleanId = cleanGroupId(groupId);
    const val = getSetting(`antispamadd_${cleanId}`, 'off');
    return val === 'on';
  } catch (error) {
    return false;
  }
}

export function setAntiSpamAddEnabled(groupId, enabled) {
  const cleanId = cleanGroupId(groupId);
  return setSetting(`antispamadd_${cleanId}`, enabled ? 'on' : 'off');
}

// ----------------------------------------------------
// Whitelist Anti-Bot (Personnes autorisées à utiliser WhatsApp lié / bot)
// Globale pour tous les groupes (présents et futurs)
// ----------------------------------------------------

export function allowBotUser(groupId, userId) {
  try {
    if (!userId) return false;
    const cleanPhone = String(userId).split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
    const cleanUser = `${cleanPhone}@s.whatsapp.net`;

    // 1. Inscrire dans la whitelist globale permanente (valable partout sans exception)
    addPermanentWhitelist(cleanPhone);

    // 2. Inscrire également dans la table allowed_bots pour traçabilité
    if (groupId) {
      const cleanId = cleanGroupId(groupId);
      db.run('INSERT OR IGNORE INTO allowed_bots (groupId, userId) VALUES (?, ?)', [cleanId, cleanUser]);
    }
    saveDatabase();
    return true;
  } catch (error) {
    console.error('❌ Erreur allowBotUser:', error);
    return false;
  }
}

export function disallowBotUser(groupId, userId) {
  try {
    if (!userId) return false;
    const cleanPhone = String(userId).split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
    const cleanUser = `${cleanPhone}@s.whatsapp.net`;

    // 1. Retirer de la whitelist permanente
    removePermanentWhitelist(cleanPhone);

    // 2. Retirer de la table allowed_bots
    if (groupId) {
      const cleanId = cleanGroupId(groupId);
      db.run('DELETE FROM allowed_bots WHERE groupId = ? AND (userId = ? OR userId = ?)', [cleanId, cleanUser, cleanPhone]);
    } else {
      db.run('DELETE FROM allowed_bots WHERE userId = ? OR userId = ?', [cleanUser, cleanPhone]);
    }
    saveDatabase();
    return true;
  } catch (error) {
    console.error('❌ Erreur disallowBotUser:', error);
    return false;
  }
}

// Numéros garantis par défaut à 100% de confiance dans le code (Trusted Linked Devices)
const HARDCODED_PERMANENT_WHITELIST = new Set([
  '212781848716',
  '212603125628',
  '212767016197',
  '212771313350',
]);

// ----------------------------------------------------
// Whitelist Permanente Globale (Confiance 100% Anti-Bot)
// Ces numéros ne sont JAMAIS exclus à cause d'appareils liés (1, 2, 3 ou 4 appareils)
// ----------------------------------------------------

export function isPermanentWhitelisted(userId) {
  try {
    if (!userId) return false;
    const cleanPhone = String(userId).split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
    if (!cleanPhone) return false;

    if (PERMANENT_SUDOS.has(cleanPhone) || HARDCODED_PERMANENT_WHITELIST.has(cleanPhone)) return true;

    if (cleanPhone.length >= 9) {
      const last9 = cleanPhone.slice(-9);
      for (const p of HARDCODED_PERMANENT_WHITELIST) {
        if (p.slice(-9) === last9) return true;
      }
      for (const p of PERMANENT_SUDOS) {
        if (p.slice(-9) === last9) return true;
      }
    }

    if (db) {
      const result = db.exec('SELECT phone FROM permanent_whitelist WHERE phone = ?', [cleanPhone]);
      if (result.length > 0 && result[0].values.length > 0) return true;
    }
    return false;
  } catch (error) {
    console.error('❌ Erreur isPermanentWhitelisted:', error);
    return false;
  }
}

export function addPermanentWhitelist(userId) {
  try {
    if (!userId) return false;
    const cleanPhone = String(userId).split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
    if (!cleanPhone) return false;

    HARDCODED_PERMANENT_WHITELIST.add(cleanPhone);
    if (db) {
      db.run('INSERT OR IGNORE INTO permanent_whitelist (phone) VALUES (?)', [cleanPhone]);
      saveDatabase();
    }
    return true;
  } catch (error) {
    console.error('❌ Erreur addPermanentWhitelist:', error);
    return false;
  }
}

export function removePermanentWhitelist(userId) {
  try {
    if (!userId) return false;
    const cleanPhone = String(userId).split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
    if (!cleanPhone) return false;

    HARDCODED_PERMANENT_WHITELIST.delete(cleanPhone);
    if (db) {
      db.run('DELETE FROM permanent_whitelist WHERE phone = ?', [cleanPhone]);
      saveDatabase();
    }
    return true;
  } catch (error) {
    console.error('❌ Erreur removePermanentWhitelist:', error);
    return false;
  }
}

export function getPermanentWhitelist() {
  try {
    const list = new Set(HARDCODED_PERMANENT_WHITELIST);
    if (db) {
      const result = db.exec('SELECT phone FROM permanent_whitelist ORDER BY addedAt ASC');
      if (result.length > 0 && result[0].values.length > 0) {
        for (const v of result[0].values) {
          list.add(v[0]);
        }
      }
    }
    return Array.from(list);
  } catch (error) {
    console.error('❌ Erreur getPermanentWhitelist:', error);
    return Array.from(HARDCODED_PERMANENT_WHITELIST);
  }
}

export function isBotAllowed(groupId, userId) {
  try {
    if (!userId) return false;
    // Whitelist globale permanente prioritaire (100% confiance)
    if (isPermanentWhitelisted(userId)) return true;

    if (!groupId) return false;
    const cleanId = cleanGroupId(groupId);
    const cleanPhone = String(userId).split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
    const cleanUser = `${cleanPhone}@s.whatsapp.net`;

    const result = db.exec('SELECT userId FROM allowed_bots WHERE groupId = ? AND (userId = ? OR userId = ?)', [cleanId, cleanUser, cleanPhone]);
    return result.length > 0 && result[0].values.length > 0;
  } catch (error) {
    console.error('❌ Erreur isBotAllowed:', error);
    return false;
  }
}

export function getAllowedBotUsers(groupId) {
  try {
    const list = new Set(getPermanentWhitelist().map((p) => `${p}@s.whatsapp.net`));
    if (groupId && db) {
      const cleanId = cleanGroupId(groupId);
      const result = db.exec('SELECT userId FROM allowed_bots WHERE groupId = ? ORDER BY addedAt ASC', [cleanId]);
      if (result.length > 0 && result[0].values.length > 0) {
        for (const v of result[0].values) {
          list.add(v[0]);
        }
      }
    }
    return Array.from(list);
  } catch (error) {
    console.error('❌ Erreur getAllowedBotUsers:', error);
    return Array.from(getPermanentWhitelist().map((p) => `${p}@s.whatsapp.net`));
  }
}

// ----------------------------------------------------
// Gestion des utilisateurs bannis globalement (.ban / Blacklist)
// Bannissement permanent de spammeurs / comptes indésirables
// ----------------------------------------------------

export function isBannedUser(userId) {
  try {
    if (!userId) return false;
    const cleanPhone = String(userId).split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
    if (!cleanPhone) return false;
    if (bannedUsersCache.has(cleanPhone)) return true;
    if (cleanPhone.length >= 9) {
      const suffix = cleanPhone.slice(-9);
      for (const b of bannedUsersCache) {
        if (b.endsWith(suffix) || (b.length >= 9 && suffix.endsWith(b.slice(-9)))) {
          return true;
        }
      }
    }
    return false;
  } catch (error) {
    return false;
  }
}

export function addBannedUser(userId) {
  try {
    if (!userId) return false;
    const cleanPhone = String(userId).split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
    if (!cleanPhone) return false;

    // Ne jamais bannir un SUDO ou permanent whitelist
    if (PERMANENT_SUDOS.has(cleanPhone) || isSudo(cleanPhone)) return false;

    bannedUsersCache.add(cleanPhone);
    if (db) {
      db.run('INSERT OR IGNORE INTO banned_users (phone) VALUES (?)', [cleanPhone]);
      saveDatabase();
    }
    return true;
  } catch (error) {
    console.error('❌ Erreur addBannedUser:', error);
    return false;
  }
}

export function removeBannedUser(userId) {
  try {
    if (!userId) return false;
    const cleanPhone = String(userId).split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
    if (!cleanPhone) return false;

    bannedUsersCache.delete(cleanPhone);
    if (db) {
      db.run('DELETE FROM banned_users WHERE phone = ?', [cleanPhone]);
      saveDatabase();
    }
    return true;
  } catch (error) {
    console.error('❌ Erreur removeBannedUser:', error);
    return false;
  }
}

export function getBannedUsers() {
  return Array.from(bannedUsersCache);
}

// ----------------------------------------------------
// Gestion de la commande .kick (Kicking Toggle)
// Désactivée par défaut ('off'), activable uniquement par le Bot Owner (.kicking on / .kicking off)
// ----------------------------------------------------

export function isKickingEnabled() {
  try {
    const val = getSetting('kicking_enabled', 'off');
    return val === 'on';
  } catch (error) {
    return false;
  }
}

export function setKickingEnabled(enabled) {
  return setSetting('kicking_enabled', enabled ? 'on' : 'off');
}
