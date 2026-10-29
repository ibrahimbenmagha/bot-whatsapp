# 📚 Guide Complet d'Intégration et de Fonctionnement

## 🎯 Vue d'Ensemble

Ce bot effectue une **modération automatique** d'un groupe WhatsApp en gérant :
1. **Anti-Lien** : Supprime les URLs envoyées par les non-admins
2. **Système de Warnings** : 3 avertissements = exclusion du groupe
3. **Commandes Admin** : Gestion manuelle des warnings

---

## 🚀 Étape 1 : Installation et Démarrage

### A. Vérifier les Prérequis

```bash
# Vérifier Node.js (v16+)
node --version

# Vérifier npm
npm --version
```

### B. Démarrer le Bot

```bash
cd c:\Users\DELL\Desktop\WebProjectFs\BotWhatsapp
npm start
```

### C. Résultat Attendu

```
🚀 Initialisation du bot WhatsApp...
✅ Base de données initialisée avec succès
✅ Socket WhatsApp initialisée avec succès

🎉 Bot prêt et en attente de messages...

⏳ Connexion en cours...
📱 Scannez ce QR code avec votre téléphone WhatsApp:

██████████████████████████████████████████████
██______________________________________██
██  [QR CODE AFFICHÉ ICI]
██______________________________________██
██████████████████████████████████████████████
```

---

## 📱 Étape 2 : Authentification WhatsApp

### A. Scanner le QR Code

1. **Lancer le bot** avec `npm start`
2. **Ouvrir WhatsApp** sur votre téléphone
3. Aller dans **Paramètres** → **Appareils liés** (ou **Whatsapp Web**)
4. Cliquer sur **Lier un appareil**
5. **Scanner le QR code** affiché dans le terminal

### B. Vérification de Connexion

Après le scan, vous verrez :

```
✅ Bot connecté avec succès!
🎉 Bot prêt et en attente de messages...
```

Le bot a maintenant accès à tous vos groupes et contacts.

---

## 🔧 Étape 3 : Configuration du Groupe Cible

### A. Modifier le Nom du Groupe dans `index.js`

```javascript
const CONFIG = {
  targetGroupName: 'Votre Nom du Groupe',  // ← À MODIFIER
  maxWarnings: 3,                          // Nombre max avant exclusion
};
```

**Exemple :**
```javascript
const CONFIG = {
  targetGroupName: 'Modération Test',
  maxWarnings: 3,
};
```

### B. Vérifier les Permissions du Bot

Le bot doit être **administrateur** du groupe pour :
- ✅ Supprimer les messages
- ✅ Expulser des membres
- ✅ Lire les informations du groupe

---

## ⚙️ Étape 4 : Fonctionnement du Bot

### 📊 Architecture du Flux de Traitement

```
Message Reçu
    │
    ├─ C'est du bot lui-même ? → Ignorer
    ├─ C'est une notification système ? → Ignorer
    │
    ├─ C'est un message de groupe ? 
    │   ├─ Extraire le texte du message
    │   ├─ Récupérer les infos du groupe
    │   │
    │   ├─ Message de lien ? (http:// ou https://)
    │   │   ├─ Expéditeur est admin ? → Autoriser
    │   │   └─ Expéditeur n'est pas admin ?
    │   │       ├─ Supprimer le message
    │   │       ├─ Ajouter 1 warning
    │   │       ├─ Warning count == 3 ? → Exclure
    │   │       └─ Envoyer une alerte
    │   │
    │   └─ Commande d'admin ? (!warn @utilisateur)
    │       ├─ Expéditeur est admin ?
    │       │   ├─ Parse la commande
    │       │   ├─ Ajouter 1 warning
    │       │   ├─ Warning count == 3 ? → Exclure
    │       │   └─ Envoyer confirmation
    │       └─ Expéditeur n'est pas admin ? → Ignorer
    │
    └─ Fin du traitement
```

### 🔍 Détail de Chaque Fonction

#### 1. **Anti-Lien Automatique**

**Déclencheur :** Message contenant une URL

**Actions :**
1. Détecte `http://` ou `https://` dans le message
2. Vérifie si l'auteur est admin (admins = autorisés)
3. Si non-admin :
   - ❌ Supprime le message pour tout le monde
   - ⚠️ Ajoute 1 warning en base de données
   - 📢 Tag l'utilisateur avec un avertissement public
   - Si 3 warnings : 🚫 Exclusion du groupe

**Exemple en Pratique :**

```
❌ AVANT (Message visible 2 secondes) :
  Utilisateur : "Regardez ça : https://example.com/lien"

✅ APRÈS (Message supprimé) :
  Bot : "⚠️ @212612345678 Lien détecté et supprimé! Warning 1/3"
```

#### 2. **Système de Warnings**

**Base de Données (SQLite) :**

| groupId | userId | count | createdAt | updatedAt |
|---------|--------|-------|-----------|-----------|
| 123456789@g.us | 212612345678@s.whatsapp.net | 1 | 2024-01-01 | 2024-01-01 |
| 123456789@g.us | 212698765432@s.whatsapp.net | 3 | 2024-01-01 | 2024-01-05 |

**Progression :**
- **1er warning :** ⚠️ Avertissement public
- **2e warning :** ⚠️⚠️ Avertissement doublé
- **3e warning :** 🚫 Exclusion automatique

#### 3. **Commande Admin : `!warn @utilisateur`**

**Syntaxe :**
```
!warn @212612345678
```

**Actions :**
```
Bot reçoit : "!warn @212612345678"
  ├─ Vérifie : Est-ce que le sender est admin ? ✅ OUI
  ├─ Parse : Extrait le numéro (@212612345678)
  ├─ Recherche : Trouve cet utilisateur dans le groupe
  ├─ Ajoute : 1 warning à la base de données
  ├─ Vérifie : Total warnings == 3 ? 
  │   ├─ OUI → Exclut l'utilisateur et réinitialise les warnings
  │   └─ NON → Envoie juste la mise à jour
  └─ Répond : "✅ Warning ajouté. Total: 2/3"
```

---

## 💡 Cas d'Usage Réels

### Cas 1 : Un Non-Admin Envoie un Lien

```
❌ Message entrant:
   Utilisateur: "Super lien c'est cool https://youtube.com/video"
   
✅ Actions du bot:
   1. Supprime le message entièrement
   2. Ajoute 1 warning (total: 1)
   3. Envoie: "⚠️ @212612345678 Lien détecté et supprimé! Warning 1/3"

✅ Base de données mise à jour:
   groupId: 123456789@g.us
   userId: 212612345678@s.whatsapp.net
   count: 1 ✓
```

### Cas 2 : Un Admin Envoie un Lien

```
✅ Message entrant:
   Admin: "Documentation: https://docs.example.com"

✅ Actions du bot:
   1. ✅ AUTORISE le message (l'admin peut poster des liens)
   2. Ne supprime rien
   3. No warning ajouté
```

### Cas 3 : Accumulation de 3 Warnings

```
⚠️ État initial:
   Utilisateur: 2 warnings existants

❌ Message entrant:
   Utilisateur: "Voici https://site.com"

🚫 Actions du bot:
   1. Supprime le message
   2. Ajoute 1 warning (total: 3)
   3. **EXCLUSION AUTOMATIQUE** :
      - Retire l'utilisateur du groupe
      - Réinitialise son compteur de warnings
      - Envoie: "🚫 @212612345678 a été exclu du groupe (3 warnings atteints)"
```

---

## 📊 Fichiers et Structure

### 📁 Fichiers Importants

| Fichier | Rôle |
|---------|------|
| `index.js` | Cœur du bot (socket WhatsApp + handlers) |
| `db.js` | Fonctions SQLite (warnings, stats) |
| `utils/helpers.js` | Utilitaires (isAdmin, extractMessage, etc.) |
| `auth_info_multi/` | Dossier de session (créé automatiquement) |
| `botdata.db` | Base de données SQLite (créée automatiquement) |

### 🔐 Fichiers à Ignorer (en .gitignore)

```
node_modules/          # Dépendances
auth_info_multi/       # Session WhatsApp (sensible!)
botdata.db            # Base de données locale
.DS_Store / Thumbs.db # Fichiers système
```

---

## 🧪 Test du Bot

### Test 1 : Anti-Lien

1. **Groupe créé et bot admin ?** ✅
2. **Envoyer un message normal** → Bot ne réagit pas ✅
3. **Envoyer un lien (non-admin)** → Message supprimé + warning ✅
4. **Envoyer un lien (admin)** → Message autorisé ✅

### Test 2 : Warnings

1. **Envoyer 3 liens (non-admin)** → Exclusion à la 3e ✅
2. **Commande `!warn @numero`** → Increase warning ✅
3. **Vérifier la DB** : `SELECT * FROM warnings` ✅

### Test 3 : Commandes

1. **Envoyer `!warn @numero` (non-admin)** → Ignoré ✅
2. **Envoyer `!warn @numero` (admin)** → Warning ajouté ✅
3. **Envoyer `!warn invalide`** → Message d'erreur ✅

---

## 🐛 Dépannage

### Q1 : "Bot ne se connecte pas"

**Cause :** Problème de connexion WhatsApp

**Solution :**
```bash
# 1. Supprimer la session
Remove-Item -Path "./auth_info_multi" -Recurse -Force

# 2. Redémarrer
npm start

# 3. Scanner le QR code à nouveau
```

### Q2 : "Bot n'affiche pas le QR code"

**Cause :** Terminal ne supporte pas les codes QR

**Solution :**
- Utiliser un autre terminal (Git Bash, WSL2, ou Command Prompt)
- Vérifier la version de Node.js (16+)

### Q3 : "Bot ne fait rien au messages"

**Cause :** Probablement un problème de groupe

**Solution :**
1. Vérifier le nom du groupe dans `index.js` → CONFIG
2. Vérifier que le bot est **admin** du groupe
3. Vérifier les logs : `npm start` (avec logs activés)

### Q4 : "Erreur : Could not locate bindings file"

**Cause :** Manque de dépendances natives (better-sqlite3)

**Solution :**
```bash
npm install --ignore-scripts
npm install sql.js
```

---

## 🔄 Cycle de Vie du Bot

```
DÉMARRAGE
   │
   ├─ Initialise la base de données SQLite
   ├─ Crée la socket Baileys
   ├─ Charge la session existante (ou crée en)
   │
   └─► ATTENTE DE CONNEXION
       ├─ Affiche le QR code
       ├─ Scanne avec WhatsApp
       │
       └─► CONNECTÉ ✅
           ├─ Écoute tous les messages
           ├─ Vérifie les règles de modération
           ├─ Met à jour la base de données
           │
           └─► EN ATTENTE DE MESSAGES
               ├─ Message entrant ?
               │   ├─ Anti-lien ? → Action
               │   ├─ Commande ? → Action
               │   └─ Normal → Ignore
               │
               ├─ Déconnexion ?
               │   └─ Reconnexion auto...
               │
               └─ [Boucle continue]
```

---

## 🎓 Exemples de Code Important

### 1. Vérifier si quelqu'un est Admin

```javascript
// Dans helpers.js
export function isAdmin(participantId, groupData) {
  const participant = groupData.participants.find(
    (p) => p.id === participantId
  );
  return participant?.admin === 'admin' || participant?.admin === 'superadmin';
}

// Utilisation
const isUserAdmin = isAdmin(senderId, groupData);
```

### 2. Ajouter un Warning

```javascript
// Dans db.js
export function addWarning(groupId, userId) {
  // Récupère le count existant
  // Incrément par 1
  // Sauvegarde en DB
  return newCount; // Retourne le nouveau total
}

// Utilisation
const warnings = addWarning(groupJid, senderJid);
console.log(`Warnings: ${warnings}/3`);
```

### 3. Supprimer un Message

```javascript
// Dans index.js
await sock.sendMessage(jid, {
  delete: {
    remoteJid: jid,
    fromMe: false,
    id: messageId
  }
});
```

### 4. Exclure un Utilisateur

```javascript
// Dans index.js
await sock.groupParticipantsUpdate(
  groupJid,
  [userJid],
  'remove'  // 'add' pour ajouter, 'remove' pour exclure
);
```

---

## 📈 Améliorations Possibles

- [ ] **Whitelist de groupes** : Modérer plusieurs groupes
- [ ] **Commandes supplémentaires** : `!kick @user`, `!warn list`, `!reset`
- [ ] **Regex personnalisés** : Anti-spam, anti-promotions
- [ ] **Dashboard web** : Voir les warnings en temps réel
- [ ] **Logs persistants** : Historique des modérations
- [ ] **Notifications** : Alerter les admins dans un groupe séparé

---

## 🎉 Résumé

| Aspect | Détail |
|--------|--------|
| **Démarrage** | `npm start` |
| **Authentification** | Scanner QR code WhatsApp |
| **Fonctionnement** | Écoute messages → Applique règles → Met à jour DB |
| **Anti-Lien** | Détecte URL → Supprime si non-admin |
| **Warnings** | 1 par infraction → 3e = exclusion |
| **Base de Données** | SQLite locale (botdata.db) |
| **Logs** | Terminal (pino logger) |
| **Admin** | Bot doit être admin du groupe |

---

**Bon modération ! 🚀**
