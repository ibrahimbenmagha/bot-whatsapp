import initSqlJs from 'sql.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATABASE_PATH = path.join(__dirname, 'botdata.db');

let db = null;
let SQL = null;

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

    // Insérer le numéro initial 212781848716 par défaut
    db.run(`INSERT OR IGNORE INTO permanent_whitelist (phone) VALUES ('212781848716')`);

    saveDatabase();
    console.log('✅ Base de données initialisée avec succès (tables warnings, settings, sudos, allowed_links, allowed_bots, permanent_whitelist)');
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
    const result = db.exec('SELECT value FROM settings WHERE key = ?', [key]);
    if (result.length > 0 && result[0].values.length > 0) {
      return result[0].values[0][0];
    }
    return defaultValue;
  } catch (error) {
    console.error('❌ Erreur getSetting:', error);
    return defaultValue;
  }
}

export function setSetting(key, value) {
  try {
    db.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [key, String(value)]);
    saveDatabase();
    return true;
  } catch (error) {
    console.error('❌ Erreur setSetting:', error);
    return false;
  }
}

export function getBotMode() {
  return getSetting('bot_mode', 'public');
}

export function setBotMode(mode) {
  const cleanMode = mode === 'private' ? 'private' : 'public';
  return setSetting('bot_mode', cleanMode);
}

// ----------------------------------------------------
// Gestion des utilisateurs SUDO
// ----------------------------------------------------

export function isSudo(userId) {
  try {
    if (!userId) return false;
    const cleanUser = userId.split('@')[0].split(':')[0] + '@s.whatsapp.net';
    const result = db.exec('SELECT userId FROM sudos WHERE userId = ?', [cleanUser]);
    return result.length > 0 && result[0].values.length > 0;
  } catch (error) {
    console.error('❌ Erreur isSudo:', error);
    return false;
  }
}

export function addSudo(userId) {
  try {
    if (!userId) return false;
    const cleanUser = userId.split('@')[0].split(':')[0] + '@s.whatsapp.net';
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
    const cleanUser = userId.split('@')[0].split(':')[0] + '@s.whatsapp.net';
    db.run('DELETE FROM sudos WHERE userId = ?', [cleanUser]);
    saveDatabase();
    return true;
  } catch (error) {
    console.error('❌ Erreur removeSudo:', error);
    return false;
  }
}

export function getSudoList() {
  try {
    const result = db.exec('SELECT userId FROM sudos ORDER BY addedAt ASC');
    if (result.length > 0 && result[0].values.length > 0) {
      return result[0].values.map(v => v[0]);
    }
    return [];
  } catch (error) {
    console.error('❌ Erreur getSudoList:', error);
    return [];
  }
}

// ----------------------------------------------------
// Gestion de l'Anti-Link et Liste Blanche (Allowed Links)
// ----------------------------------------------------

export function isAntiLinkEnabled(groupId) {
  try {
    if (!groupId) return true;
    const val = getSetting(`antilink_${groupId}`, 'on');
    return val !== 'off';
  } catch (error) {
    return true;
  }
}

export function setAntiLinkEnabled(groupId, enabled) {
  return setSetting(`antilink_${groupId}`, enabled ? 'on' : 'off');
}

export function allowLinkUser(groupId, userId) {
  try {
    if (!groupId || !userId) return false;
    const cleanUser = userId.split('@')[0].split(':')[0] + '@s.whatsapp.net';
    db.run('INSERT OR IGNORE INTO allowed_links (groupId, userId) VALUES (?, ?)', [groupId, cleanUser]);
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
    const cleanUser = userId.split('@')[0].split(':')[0] + '@s.whatsapp.net';
    db.run('DELETE FROM allowed_links WHERE groupId = ? AND userId = ?', [groupId, cleanUser]);
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
    const cleanUser = userId.split('@')[0].split(':')[0] + '@s.whatsapp.net';
    const result = db.exec('SELECT userId FROM allowed_links WHERE groupId = ? AND userId = ?', [groupId, cleanUser]);
    return result.length > 0 && result[0].values.length > 0;
  } catch (error) {
    console.error('❌ Erreur isLinkAllowed:', error);
    return false;
  }
}

export function getAllowedLinkUsers(groupId) {
  try {
    if (!groupId) return [];
    const result = db.exec('SELECT userId FROM allowed_links WHERE groupId = ? ORDER BY addedAt ASC', [groupId]);
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
    if (!groupId) return true;
    const val = getSetting(`antibot_${groupId}`, 'on');
    return val !== 'off';
  } catch (error) {
    return true;
  }
}

export function setAntiBotEnabled(groupId, enabled) {
  return setSetting(`antibot_${groupId}`, enabled ? 'on' : 'off');
}

// ----------------------------------------------------
// Paramètres Anti-Spam (Transfert de messages successifs)
// ----------------------------------------------------

export function isAntiSpamEnabled(groupId) {
  try {
    if (!groupId) return true;
    const val = getSetting(`antispam_${groupId}`, 'on');
    return val !== 'off';
  } catch (error) {
    return true;
  }
}

export function setAntiSpamEnabled(groupId, enabled) {
  return setSetting(`antispam_${groupId}`, enabled ? 'on' : 'off');
}

// ----------------------------------------------------
// Whitelist Anti-Bot (Personnes autorisées à utiliser WhatsApp lié / bot)
// ----------------------------------------------------

export function allowBotUser(groupId, userId) {
  try {
    if (!groupId || !userId) return false;
    const cleanUser = userId.split('@')[0].split(':')[0] + '@s.whatsapp.net';
    db.run('INSERT OR IGNORE INTO allowed_bots (groupId, userId) VALUES (?, ?)', [groupId, cleanUser]);
    saveDatabase();
    return true;
  } catch (error) {
    console.error('❌ Erreur allowBotUser:', error);
    return false;
  }
}

export function disallowBotUser(groupId, userId) {
  try {
    if (!groupId || !userId) return false;
    const cleanUser = userId.split('@')[0].split(':')[0] + '@s.whatsapp.net';
    db.run('DELETE FROM allowed_bots WHERE groupId = ? AND userId = ?', [groupId, cleanUser]);
    saveDatabase();
    return true;
  } catch (error) {
    console.error('❌ Erreur disallowBotUser:', error);
    return false;
  }
}

// Numéros garantis par défaut à 100% de confiance dans le code
const HARDCODED_PERMANENT_WHITELIST = new Set([
  '212781848716',
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

    if (HARDCODED_PERMANENT_WHITELIST.has(cleanPhone)) return true;

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
    if (isPermanentWhitelisted(userId)) return true;
    if (!groupId) return false;

    const cleanUser = userId.split('@')[0].split(':')[0] + '@s.whatsapp.net';
    const result = db.exec('SELECT userId FROM allowed_bots WHERE groupId = ? AND userId = ?', [groupId, cleanUser]);
    return result.length > 0 && result[0].values.length > 0;
  } catch (error) {
    console.error('❌ Erreur isBotAllowed:', error);
    return false;
  }
}

export function getAllowedBotUsers(groupId) {
  try {
    if (!groupId) return [];
    const result = db.exec('SELECT userId FROM allowed_bots WHERE groupId = ? ORDER BY addedAt ASC', [groupId]);
    if (result.length > 0 && result[0].values.length > 0) {
      return result[0].values.map(v => v[0]);
    }
    return [];
  } catch (error) {
    console.error('❌ Erreur getAllowedBotUsers:', error);
    return [];
  }
}
