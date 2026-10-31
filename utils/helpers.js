/**
 * Normaliser un JID WhatsApp (enlever le suffixe de device :8@s.whatsapp.net tout en préservant le domaine @s.whatsapp.net ou @lid)
 * @param {string} jid 
 * @returns {string}
 */
export function normalizeJid(jid) {
  if (!jid) return '';
  const [user, server] = jid.split('@');
  const cleanUser = user.split(':')[0];
  const targetServer = server ? (server.includes('lid') ? 'lid' : 's.whatsapp.net') : 's.whatsapp.net';
  return `${cleanUser}@${targetServer}`;
}

/**
 * Vérifier si un participant est admin du groupe (compatible PN JID et LID)
 * @param {string} participantId - ID du participant
 * @param {Object} groupData - Données du groupe (contient le tableau participants)
 * @returns {boolean}
 */
export function isAdmin(participantId, groupData) {
  try {
    if (!groupData || !groupData.participants) {
      return false;
    }

    const targetUser = participantId ? participantId.split('@')[0].split(':')[0] : '';
    if (!targetUser) return false;

    const participant = groupData.participants.find((p) => {
      const idUser = (p.id || '').split('@')[0].split(':')[0];
      const jidUser = (p.jid || '').split('@')[0].split(':')[0];
      const lidUser = (p.lid || '').split('@')[0].split(':')[0];
      return idUser === targetUser || jidUser === targetUser || lidUser === targetUser;
    });

    return participant ? participant.admin === 'admin' || participant.admin === 'superadmin' : false;
  } catch (error) {
    console.error('❌ Erreur lors de la vérification des droits admin:', error);
    return false;
  }
}

/**
 * Extraire le texte d'un message Baileys (supporte éphémère, vue unique, etc.)
 * @param {Object} message - Objet du message Baileys
 * @returns {string|null}
 */
export function extractMessage(message) {
  try {
    let msg = message?.message;
    if (!msg) return null;

    // Déballer les conteneurs spéciaux (messages éphémères, vue unique)
    if (msg.ephemeralMessage?.message) msg = msg.ephemeralMessage.message;
    if (msg.viewOnceMessage?.message) msg = msg.viewOnceMessage.message;
    if (msg.viewOnceMessageV2?.message) msg = msg.viewOnceMessageV2.message;
    if (msg.documentWithCaptionMessage?.message) msg = msg.documentWithCaptionMessage.message;

    // Message texte simple
    if (msg.conversation) return msg.conversation;

    // Message texte avec contexte quoté
    if (msg.extendedTextMessage?.text) return msg.extendedTextMessage.text;

    // Message image/vidéo avec caption
    if (msg.imageMessage?.caption) return msg.imageMessage.caption;
    if (msg.videoMessage?.caption) return msg.videoMessage.caption;

    // Message document avec caption
    if (msg.documentMessage?.caption) return msg.documentMessage.caption;

    return null;
  } catch (error) {
    console.error('❌ Erreur lors de l\'extraction du message:', error);
    return null;
  }
}

/**
 * Vérifier si un texte contient une URL
 * @param {string} text - Texte à vérifier
 * @returns {boolean}
 */
export function containsUrl(text) {
  if (!text) return false;
  const urlRegex = /(?:https?:\/\/|www\.)\S+/gi;
  return urlRegex.test(text);
}

/**
 * Extraire le premier numéro de groupe d'un jid
 * @param {string} jid - JID du groupe (ex: "123456789-1234567890@g.us")
 * @returns {string}
 */
export function getGroupId(jid) {
  return jid.split('@')[0];
}

/**
 * Vérifier si un JID est un groupe
 * @param {string} jid - JID à vérifier
 * @returns {boolean}
 */
export function isGroupMessage(jid) {
  return jid.endsWith('@g.us');
}

/**
 * Formater un numéro WhatsApp pour la mention
 * @param {string} jid - JID de l'utilisateur
 * @returns {string}
 */
export function formatMention(jid) {
  return `@${jid.split('@')[0].split(':')[0]}`;
}
