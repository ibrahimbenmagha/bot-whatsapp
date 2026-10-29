/**
 * Vérifier si un participant est admin du groupe
 * @param {string} participantId - ID du participant
 * @param {Object} groupData - Données du groupe (contient le tableau participants)
 * @returns {boolean}
 */
export function isAdmin(participantId, groupData) {
  try {
    if (!groupData || !groupData.participants) {
      return false;
    }

    const participant = groupData.participants.find(
      (p) => p.id === participantId
    );

    return participant ? participant.admin === 'admin' || participant.admin === 'superadmin' : false;
  } catch (error) {
    console.error('❌ Erreur lors de la vérification des droits admin:', error);
    return false;
  }
}

/**
 * Extraire le texte d'un message Baileys
 * @param {Object} message - Objet du message Baileys
 * @returns {string|null}
 */
export function extractMessage(message) {
  try {
    const msg = message?.message;

    if (!msg) return null;

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
  return `@${jid.split('@')[0]}`;
}
