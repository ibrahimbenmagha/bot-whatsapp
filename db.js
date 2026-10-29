import initSqlJs from 'sql.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATABASE_PATH = path.join(__dirname, 'botdata.db');

let db = null;
let SQL = null;

/**
 * Initialiser la base de données SQLite et créer la table des warnings
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

    // Créer la table des warnings si elle n'existe pas
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

    saveDatabase();
    console.log('✅ Base de données initialisée avec succès');
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
 * @param {string} groupId - ID du groupe
 * @param {string} userId - ID de l'utilisateur
 * @returns {number} Le nouveau nombre de warnings
 */
export function addWarning(groupId, userId) {
  try {
    // Vérifier si l'utilisateur existe déjà
    const result = db.exec(
      'SELECT count FROM warnings WHERE groupId = ? AND userId = ?',
      [groupId, userId]
    );

    if (result.length > 0 && result[0].values.length > 0) {
      const count = result[0].values[0][0];
      // Incrémenter le compte
      db.run(
        'UPDATE warnings SET count = count + 1, updatedAt = CURRENT_TIMESTAMP WHERE groupId = ? AND userId = ?',
        [groupId, userId]
      );
      saveDatabase();
      return count + 1;
    } else {
      // Créer une nouvelle entrée
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
 * @param {string} groupId - ID du groupe
 * @param {string} userId - ID de l'utilisateur
 * @returns {number} Le nombre de warnings
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
 * @param {string} groupId - ID du groupe
 * @param {string} userId - ID de l'utilisateur
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
 * @param {string} groupId - ID du groupe
 * @returns {Array} Liste des warnings
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
