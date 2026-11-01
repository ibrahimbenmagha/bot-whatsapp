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

    saveDatabase();
    console.log('✅ Base de données initialisée avec succès (tables warnings, settings, sudos)');
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
export function addWarning(groupId, userId) {
  try {
    const result = db.exec(
      'SELECT count FROM warnings WHERE groupId = ? AND userId = ?',
      [groupId, userId]
    );

    if (result.length > 0 && result[0].values.length > 0) {
      const count = result[0].values[0][0];
      db.run(
        'UPDATE warnings SET count = count + 1, updatedAt = CURRENT_TIMESTAMP WHERE groupId = ? AND userId = ?',
        [groupId, userId]
      );
      saveDatabase();
      return count + 1;
    } else {
      db.run(
        'INSERT INTO warnings (groupId, userId, count) VALUES (?, ?, 1)',
        [groupId, userId]
      );
      saveDatabase();
      return 1;
    }
  } catch (error) {
    console.error('❌ Erreur lors de l\'ajout d\'un warning:', error);
    return 0;
  }
}

/**
 * Récupérer le nombre de warnings d'un utilisateur
 */
export function getWarningCount(groupId, userId) {
  try {
    const result = db.exec(
      'SELECT count FROM warnings WHERE groupId = ? AND userId = ?',
      [groupId, userId]
    );

    if (result.length > 0 && result[0].values.length > 0) {
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
export function resetWarnings(groupId, userId) {
  try {
    db.run(
      'DELETE FROM warnings WHERE groupId = ? AND userId = ?',
      [groupId, userId]
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
