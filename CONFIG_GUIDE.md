# ⚙️ Guide de Configuration du Bot

Ce document explique comment personnaliser le bot selon vos besoins.

---

## 🎯 Configuration de Base

### 1. Modifier le Groupe Cible

**Fichier :** `index.js` (ligne 15-18)

```javascript
// AVANT :
const CONFIG = {
  targetGroupName: 'Votre Nom du Groupe', // ← À CHANGER
  maxWarnings: 3,
};

// APRÈS (exemple) :
const CONFIG = {
  targetGroupName: 'Modération Dev',
  maxWarnings: 3,
};
```

**Comment trouver le nom exact du groupe :**
1. Ouvert WhatsApp
2. Allez dans le groupe que vous ciblez
3. Cliquez sur le nom du groupe en haut
4. Copier le nom exact (avec majuscules, accents, etc.)

### 2. Modifier le Nombre Maximum de Warnings

```javascript
// Pour 5 warnings avant exclusion :
const CONFIG = {
  targetGroupName: 'Modération Dev',
  maxWarnings: 5,  // ← Changé
};
```

---

## 🔧 Configurations Avancées

### 3. Activer les Logs Détaillés

**Fichier :** `index.js` (ligne 20)

```javascript
// Pour DEBUG :
const logger = pino({ level: 'debug' }); // Affiche TOUS les logs

// Pour PRODUCTION (actuel) :
const logger = pino({ level: 'silent' }); // Discret
```

### 4. Changer le Délai de Reconnexion

**Fichier :** `index.js` (ligne 89-94)

```javascript
// Augmenter le délai en cas de problème réseau :
const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;

if (shouldReconnect) {
  console.log('🔄 Reconnexion dans DUO SECONDES...'); // 👈 Duée de DÉLAI
  setTimeout(() => initializeSocket(), 10000); // 👈 10000ms = 10 secondes
}
```

### 5. Filtrer Plusieurs Groupes (Avancé)

**Option :** Regarder tous les groupes au lieu d'un seul

**Fichier :** `index.js`, fonction `handleNewMessages` (ligne 123-125)

**Par défaut :**
```javascript
const jid = msg.key.remoteJid;
// ...
if (!isGroupMessage(jid)) continue;
// Traite TOUS les groupes
```

**Pour filtrer un groupe spécifique :**
```javascript
const jid = msg.key.remoteJid;
const groupData = await sock.groupMetadata(jid);

// Ajouter cette vérification :
if (groupData.subject !== CONFIG.targetGroupName) {
  continue; // Ignorer les autres groupes
}
```

---

## 🎨 Personnaliser les Messages

### 6. Messages d'Avertissement Anti-Lien

**Fichier :** `index.js`, fonction `handleAntiLink` (ligne 166-178)

```javascript
// AVANT :
let notificationText = `⚠️ ${senderMention} Lien détecté et supprimé! Warning ${newWarningCount}/${CONFIG.maxWarnings}`;

// APRÈS (personnalisé) :
let notificationText = `⚠️ ${senderMention} - Il est interdit de poster des liens ici! ` +
                       `Infraction ${newWarningCount}/${CONFIG.maxWarnings}`;
```

### 7. Message d'Exclusion

**Fichier :** `index.js`, fonction `handleUserKick` (ligne 213-220)

```javascript
// AVANT :
await sock.sendMessage(jid, { text: `🚫 ${userName} a été exclu du groupe pour violation répétée des règles.` });

// APRÈS (personnalisé) :
await sock.sendMessage(jid, { 
  text: `⛔ ${userName} a été bannie du groupe après 3 avertissements. Respectez les règles !` 
});
```

### 8. Message de Commande `!warn`

**Fichier :** `index.js`, fonction `handleWarnCommand` (ligne 189-211)

```javascript
// Contrôle des messages d'erreur et de succès :

// Message "utilisateur introuvable" :
if (!targetParticipant) {
  await sock.sendMessage(jid, { text: '❌ Utilisateur non trouvé dans le groupe' });
  return;
}

// Message "warning ajouté" :
let responseText = `✅ Warning ajouté pour ${targetMention}. Total: ${newWarningCount}/${CONFIG.maxWarnings}`;
```

---

## 🚀 Modes d'Exécution

### 9. Mode Développement (Avec Hot-Reload)

**Utiliser nodemon :**

```bash
npm run dev
```

Chaque modification du fichier redémarre automatiquement le bot.

### 10. Mode Production (Normal)

```bash
npm start
```

Exécution unique, pas de rechargement.

---

## 🗃️ Gestion de la Base de Données

### 11. Réinitialiser Tous les Warnings

**Via Terminal :**

```bash
# Supprimer complètement la base de données
Remove-Item -Path "./botdata.db" -Force

# Relancer le bot (crée une nouvelle DB vierge)
npm start
```

### 12. Inspecter les Données

**Via Terminal (PowerShell) :**

```bash
# Afficher tous les warnings
node -e "import('./db.js').then(async (m) => { const db = await m.initializeDatabase(); console.log(m.getGroupWarnings('YOUR_GROUP_ID')); })"
```

**Via DB Browser for SQLite :**

1. Télécharger : https://sqlitebrowser.org/
2. Ouvrir `botdata.db`
3. Onglet "Browse Data" → Table `warnings`

### 13. Réinitialiser les Warnings d'un Utilisateur

**Éditer la DB directement :**

```sql
-- Supprimer les warnings d'un utilisateur
DELETE FROM warnings WHERE userId = '212612345678@s.whatsapp.net';

-- Ou simplement diminuer le count
UPDATE warnings SET count = 1 WHERE userId = '212612345678@s.whatsapp.net';
```

---

## 🔐 Sécurité

### 14. Protéger la Session WhatsApp

**Important :** Le dossier `auth_info_multi/` est **sensible** !

```
❌ NE JAMAIS partager :
   - auth_info_multi/  (contient les clés de session)
   - En le listant sur GitHub
   - En l'envoyant par email

✅ À faire :
   - Ajouter au .gitignore (déjà fait)
   - Stocker en local uniquement
   - Utiliser des variables d'env pour les données sensibles
```

### 15. Restreindre l'Accès aux Commandes

**Actuellement :** Seuls les admins du groupe peuvent utiliser `!warn`

Pour ajouter une "whitelist d'admirateurs du bot" :

```javascript
const BOT_ADMINS = [
  '212612345678@s.whatsapp.net',  // Admin #1
  '212698765432@s.whatsapp.net',  // Admin #2
];

// Dans handleWarnCommand :
if (!senderIsAdmin && !BOT_ADMINS.includes(senderId)) {
  return; // Ignoré si pas admin ET pas dans whitelist
}
```

---

## 📊 Versions et Mise à Jour

### 16. Vérifier les Versions

```bash
# Vérifier les versions installées
npm list

# Resultat example :
# bot-whatsapp-moderation@1.0.0
# ├── @whiskeysockets/baileys@6.7.21
# ├── pino@8.17.2
# ├── qrcode-terminal@0.12.0
# └── sql.js@1.x.x
```

### 17. Mettre à Jour les Dépendances

```bash
# Vérifier les mises à jour disponibles
npm outdated

# Mettre à jour tout
npm update

# Mettre à jour une dépendance spécifique
npm update @whiskeysockets/baileys
```

---

## 🎯 Scénarios de Configuration

### Scénario 1 : Groupe Strict (Zéro Lien)

```javascript
const CONFIG = {
  targetGroupName: 'Groupe Strict',
  maxWarnings: 1,  // 1 seul warnings = exclusion
};

// Messages plus sévères
let notificationText = `⚠️ ${senderMention}LIENS INTERDITS. Exclusion automatique.`;
```

### Scénario 2 : Groupe Tolérant

```javascript
const CONFIG = {
  targetGroupName: 'Groupe Communauté',
  maxWarnings: 5,  // Plus d'avertissements
};
```

### Scénario 3 : Multi-Groupes (Avancé)

Modifier pour traiter TOUS les groupes :

```javascript
// Dans index.js, enlever le filtre de groupe
const groupData = await sock.groupMetadata(jid);
// NOTE: Traite maintenant TOUS les groupes, pas seulement celui cible

// Mais personnaliser par groupe :
if (groupData.subject === 'Groupe Strict') {
  CONFIG.maxWarnings = 1;
} else if (groupData.subject === 'Groupe Communauté') {
  CONFIG.maxWarnings = 5;
}
```

---

## 📋 Exemple Complet de Personnalisation

**Scénario :** Créer un bot pour un groupe d'entreprise strict

```javascript
// File: index.js
const CONFIG = {
  targetGroupName: 'Équipe Dev Entreprise',
  maxWarnings: 2,  // Moins de tolérance
};

const logger = pino({ level: 'silent' });

// ... dans handleAntiLink():
let notificationText = 
  `⚠️ ${senderMention} Les liens externes ne sont pas autorisés pour des raisons de sécurité. ` +
  `Infraction ${newWarningCount}/${CONFIG.maxWarnings}. Comportement répété = exclusion.`;

// ... dans handleUserKick():
await sock.sendMessage(jid, {
  text: `🔒 ${userName} a été retiré du groupe (politique de sécurité). ` +
        `Contactez un admin pour plus de détails.`
});
```

---

## ✅ Checklist de Configuration

- [ ] Nom du groupe défini correctement
- [ ] Nombre de warnings adapté à votre groupe
- [ ] Messages personnalisés selon votre culture
- [ ] Base de données réinitialisée si nécessaire
- [ ] Bot redémarré avec `npm start`
- [ ] Session WhatsApp scannée et active
- [ ] Tests effectués (`TEST_GUIDE.md`)

---

## 🆘 Support et Dépannage

**Quelque chose ne fonctionne pas ?**

1. Relancer le bot : `npm start`
2. Vérifier les logs : Consulter le terminal
3. Supprimer la session : `Remove-Item -Path "./auth_info_multi" -Recurse -Force`
4. Réinstaller les dépendances : `npm install`
5. Consulter `GUIDE_INTEGRATION.md` pour plus de détails

---

**Happy Moderation ! 🚀**
