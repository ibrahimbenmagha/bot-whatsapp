# 🤖 Bot de Modération WhatsApp

Un bot de modération automatique pour groupes WhatsApp utilisant **Baileys**, **SQLite**, et **Node.js**.

**Démarrage rapide ?** 👉 [QUICK_START.md](./QUICK_START.md) (5 minutes)

## 📋 Fonctionnalités

- ✅ **Authentification Multi-Device** : Connexion via QR code avec session persistante
- ✅ **Anti-Lien** : Supprime automatiquement les messages contenant des URLs (sauf pour les admins)
- ✅ **Système de Warnings** : 3 warnings = exclusion du groupe
- ✅ **Commandes Admin** : `!warn @utilisateur` pour ajouter un warning manuel
- ✅ **Base de Données SQLite** : Stockage persistant des infractions

## � Documentation Complète

| Document | Durée | Contenu |
|----------|-------|---------|
| **[QUICK_START.md](./QUICK_START.md)** | ⚡ 5 min | Démarrage en 5 étapes |
| **[GUIDE_INTEGRATION.md](./GUIDE_INTEGRATION.md)** | 📖 15 min | Comment ça marche en détail |
| **[TEST_GUIDE.md](./TEST_GUIDE.md)** | 🧪 10 min | Guide de tests pratiques |
| **[CONFIG_GUIDE.md](./CONFIG_GUIDE.md)** | ⚙️ 10 min | Personnaliser votre bot |
| **[ARCHITECTURE.md](./ARCHITECTURE.md)** | 🏗️ 20 min | Architecture & diagrammes |
| **[WORKFLOW.md](./WORKFLOW.md)** | 🔄 15 min | Scénarios d'utilisation |

---

## 🚀 Démarrage en 3 Commandes

```bash
# 1. Naviguez vers le dossier
cd c:\Users\DELL\Desktop\WebProjectFs\BotWhatsapp

# 2. Démarrez le bot
npm start

# 3. Scannez le QR code avec WhatsApp
# (dans Paramètres → Appareils liés)

## 📁 Structure du Projet

```
BotWhatsapp/
├── index.js                    # Point d'entrée principal
├── db.js                       # Gestion de la base de données SQLite
├── package.json                # Dépendances du projet
├── .gitignore                  # Fichiers à ignorer
├── auth_info_multi/            # Session WhatsApp (généré automatiquement)
├── botdata.db                  # Base de données SQLite (généré automatiquement)
├── handlers/                   # Gestionnaires d'événements (pour étapes futures)
│   └── [À venir]
└── utils/
    └── helpers.js              # Fonctions utilitaires
```

## ⚙️ Configuration

Avant de démarrer, modifiez `index.js` et mettez à jour :

```javascript
const CONFIG = {
  targetGroupName: 'Votre Nom du Groupe', // À changer !
  maxWarnings: 3,                          // Nombre max avant exclusion
};
```

## 📝 Commandes Disponibles

### Pour les Administrateurs

- **`!warn @numéro`** : Ajouter un warning manuel à un utilisateur
  - Exemple : `!warn @212612345678`

## 🔒 Sécurité

- Le bot détecte automatiquement les droits d'administration des utilisateurs
- Seuls les admins peuvent utiliser la commande `!warn`
- Les warnings sont persistants (stockés dans SQLite)
- La session WhatsApp est sauvegardée localement pour éviter le scan répété du QR

## 🐛 Debugging

Pour afficher les logs détaillés, modifiez la ligne dans `index.js` :

```javascript
const logger = pino({ level: 'debug' }); // À la place de 'silent'
```

## 📞 Dépannage

### "Module not found"
Assurez-vous d'avoir exécuté `npm install` et que vous utilisez Node.js 16+

### Bot ne se reconnecte pas
Supprimez le dossier `auth_info_multi/` et scannez le QR code à nouveau

### Les commandes ne fonctionnent pas
Vérifiez que le bot a les droits d'administrateur dans le groupe

## 🎯 Prochaines Étapes (Étape 2+)

- [ ] Étape 2 : Configuration de la Base de Données
- [ ] Étape 3 : Connexion Baileys et Gestion de Session
- [ ] Étape 4 : Gestionnaire de Messages et Utilitaires
- [ ] Étape 5 : Implémentation des Fonctionnalités

---

**Note** : Ce bot est pour un usage personnel/privé. Respectez les conditions d'utilisation de WhatsApp.
