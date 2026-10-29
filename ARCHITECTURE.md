# 🏗️ Architecture du Bot WhatsApp

Ce document détaille l'architecture complète, les flux de données, et les interactions de tous les composants.

---

## 📐 Architecture Globale

```
┌─────────────────────────────────────────────────────────────────────┐
│                       BOT WHATSAPP MODÉRATION                        │
│                                                                       │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                      COUCHE PRINCIPALE                       │   │
│  │                                                              │   │
│  │  ┌──────────────┐    ┌──────────────┐    ┌─────────────┐   │   │
│  │  │   index.js   │───▶│   Socket     │───▶│   Events    │   │   │
│  │  │              │    │   Baileys    │    │    Handler  │   │   │
│  │  └──────────────┘    └──────────────┘    └─────────────┘   │   │
│  │                             │                                   │   │
│  │                    ┌────────┴──────────┐                        │   │
│  │                    ▼                   ▼                        │   │
│  │            ┌──────────────┐     ┌──────────────┐              │   │
│  │            │  QR Code     │     │   Message    │              │   │
│  │            │   Display    │     │   Listener   │              │   │
│  │            └──────────────┘     └──────────────┘              │   │
│  │                                        │                        │   │
│  │                                        ▼                        │   │
│  │                    ┌──────────────────────────────┐            │   │
│  │                    │  Message Processing Pipeline │            │   │
│  │                    └──────────────────────────────┘            │   │
│  │                                                              │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                       │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                   COUCHE UTILITAIRES                          │   │
│  │                                                              │   │
│  │  ┌───────────────────┐      ┌──────────────────────────┐    │   │
│  │  │  utils/helpers.js │      │  db.js (SQL.js)          │    │   │
│  │  │                   │      │  - addWarning()          │    │   │
│  │  │ - isAdmin()       │      │  - getWarningCount()     │    │   │
│  │  │ - extractMessage()│      │  - resetWarnings()       │    │   │
│  │  │ - containsUrl()   │      │  - getGroupWarnings()    │    │   │
│  │  │ - isGroupMessage()│      │                          │    │   │
│  │  │ - formatMention() │      └──────────────────────────┘    │   │
│  │  └───────────────────┘                                       │   │
│  │                                                              │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                       │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                    COUCHE DONNÉES                            │   │
│  │                                                              │   │
│  │              ┌────────────────────────────┐                │   │
│  │              │   botdata.db (SQLite)      │                │   │
│  │              │                            │                │   │
│  │              │  Table: warnings           │                │   │
│  │              │  ├─ id (PK)               │                │   │
│  │              │  ├─ groupId               │                │   │
│  │              │  ├─ userId                │                │   │
│  │              │  ├─ count                 │                │   │
│  │              │  ├─ createdAt             │                │   │
│  │              │  └─ updatedAt             │                │   │
│  │              │                            │                │   │
│  │              └────────────────────────────┘                │   │
│  │                                                              │   │
│  │              ┌────────────────────────────┐                │   │
│  │              │  auth_info_multi/ (Session)│                │   │
│  │              │  ├─ creds.json            │                │   │
│  │              │  ├─ keys/                 │                │   │
│  │              │  └─ pre-keys.json         │                │   │
│  │              │                            │                │   │
│  │              └────────────────────────────┘                │   │
│  │                                                              │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                       │
└─────────────────────────────────────────────────────────────────────┘
                                  │
                    ┌─────────────┴─────────────┐
                    ▼                           ▼
          ┌──────────────────┐       ┌──────────────────┐
          │  WhatsApp Server │       │  Terminal Output │
          │  (Baileys)       │       │  (Logs & Alerts) │
          └──────────────────┘       └──────────────────┘
```

---

## 🔄 Flux de Traitement d'un Message

```
┌─────────────────────────────────┐
│   Message Arrive dans WhatsApp  │
└─────────────────┬───────────────┘
                  │
                  ▼
        ┌─────────────────────┐
        │  Baileys Event Hook │
        │ messages.upsert     │
        └─────────┬───────────┘
                  │
                  ▼
        ┌──────────────────────────┐
        │ handleNewMessages(m)     │
        │ (Fonction principale)    │
        └─────────┬────────────────┘
                  │
                  ▼────────────────────────┐
                  │                        │
        ┌─────────▼──────────┐   ┌────────▼─────────┐
        │  Filtres préalables │   │  Ignoré si :    │
        └─────────┬──────────┘   │ • De moi-même    │
                  │              │ • Pas de message │
                  ▼              │ • Pas un groupe  │
        ┌──────────────────────┐ └──────────────────┘
        │ Extraire le texte du │
        │ message (helpers.js) │
        └─────────┬────────────┘
                  │
                  ▼
        ┌──────────────────────────┐
        │ Récupérer les infos du   │
        │ groupe (groupMetadata)   │
        └─────────┬────────────────┘
                  │
            ┌─────┴─────┐
            ▼           ▼
      ┌──────────┐  ┌─────────────────┐
      │ Contient │  │ Commence par    │
      │ lien ?   │  │ !warn ? (cmd)   │
      │ (URL)    │  │                 │
      └────┬─────┘  └────────┬────────┘
           │                 │
           │ OUI             │ OUI
           ▼                 ▼
    ┌────────────────┐  ┌──────────────────┐
    │ handleAntiLink │  │ handleWarnCommand│
    └────────┬───────┘  └────────┬─────────┘
             │                   │
             └───────┬───────────┘
                     ▼
            ┌─────────────────────┐
            │ isAdmin() Check      │
            │ (sender est admin ?) │
            └────────┬────────────┘
                     │
        ┌────────────┴─────────────┐
        │                          │
    OUI (ADMIN)              NON (PAS ADMIN)
        │                          │
        ▼                          ▼
    ┌──────────────┐     ┌──────────────────┐
    │ AUTORISER    │     │ Supprimer msg    │
    │ Ne rien faire│     │ addWarning(db)   │
    └──────────────┘     └────────┬─────────┘
                                  │
                                  ▼
                          ┌─────────────────┐
                          │ Obtenir count   │
                          │ getWarningCount │
                          └────────┬────────┘
                                   │
                    ┌──────────────┼──────────────┐
                    │              │              │
                    ▼              ▼              ▼
                  1-2            2/3            ≥3
            ┌──────────────┐ ┌──────────────┐ ┌────────────┐
            │ Envoyer msg  │ │ Envoyer msg  │ │ EXCLUSION  │
            │ Warning 1/3  │ │ Warning 2/3  │ │ handleUser │
            │ ou 2/3       │ │ ou Warning   │ │ Kick()     │
            └──────────────┘ │ 3/3 + KICK   │ └───────┬────┘
                             └──────────────┘        │
                                                     ▼
                                            ┌─────────────────┐
                                            │ groupParticipants
                                            │Update(remove)   │
                                            │ resetWarnings   │
                                            │ Envoyer alerte  │
                                            └─────────────────┘
```

---

## 🔐 Flux d'Authentification

```
┌────────────────────────────────────────┐
│   npm start                            │
└────────────┬─────────────────────────┘
             │
             ▼
┌────────────────────────────────────────┐
│  initializeSocket()                    │
└────────────┬─────────────────────────┘
             │
             ▼
    ┌────────────────────────┐
    │ initializeDatabase()   │
    │ - Créer botdata.db    │
    │ - Créer table warnings│
    └────────┬───────────────┘
             │
             ▼
┌────────────────────────────────────────┐
│  useMultiFileAuthState()               │
│                                        │
│  Vérifier ./auth_info_multi/           │
│  ├─ Existe ? → Charger la session      │
│  └─ Pas existe ? → Nouvelle session    │
└────────────┬─────────────────────────┘
             │
             ▼
┌────────────────────────────────────────┐
│  makeWASocket()                        │
│  (Connexion Baileys)                   │
└────────────┬─────────────────────────┘
             │
             ▼
    ┌────────────────────────┐
    │ connection.update      │
    │ (Event Handler)        │
    └────────┬───────────────┘
             │
             ▼
     ┌───────────────┐
     │ qr != null ?  │
     └────┬──────┬──┘
          │      │
         OUI    NON
          │      │
          ▼      ▼
    ┌─────────┐  ┌────────────────────┐
    │ Afficher│  │ connection == open?│
    │ QR Code │  └────┬──────────┬─────┘
    │ dans    │       │          │
    │Terminal │      OUI        NON
    └─────────┘       │          │
                      ▼          ▼
                   ┌────────┐  ┌──────────┐
                   │✅ CONNECTÉ
                   │ Ready  │  │ Attendre │
                   │isConn=1│  │ nouveau  │
                   └────────┘  │ QR Code  │
                               └──────────┘
                                   │
                               (Boucle)
```

---

## 💾 Schéma de la Base de Données

```
┌──────────────────────────────────────────────────┐
│           Table: warnings                         │
├────────┬──────────┬────────┬─────────┬───────────┤
│ id     │ groupId  │ userId │ count   │ createdAt │
│(PK-AI) │(TEXT-NK) │(TEXT-NK) │(INT)   │ (DATETIME)│
├────────┼──────────┼────────┼─────────┼───────────┤
│ 1      │ 123@g.us │ 212@.. │ 1       │ 2024-01.. │
│ 2      │ 123@g.us │ 213@.. │ 2       │ 2024-01.. │
│ 3      │ 456@g.us │ 514@.. │ 3       │ 2024-01.. │
└────────┴──────────┴────────┴─────────┴───────────┘
│ updatedAt │
├───────────┤
│ 2024-01.. │
│ 2024-01.. │
│ 2024-01.. │
└───────────┘

Contraintes :
├─ PRIMARY KEY: id
├─ UNIQUE: (groupId, userId)
├─ DEFAULT count: 0
└─ AUTO_INCREMENT: id
```

---

## 📦 Structure des Fichiers

```
BotWhatsapp/
│
├── 📄 index.js
│   └─ Cœur du bot (600+ lignes)
│      ├─ initializeSocket()
│      ├─ handleConnectionUpdate()
│      ├─ handleNewMessages()
│      ├─ handleAntiLink()
│      ├─ handleWarnCommand()
│      ├─ handleUserKick()
│      └─ handleGroupUpdate()
│
├── 📄 db.js
│   └─ Gestion SQLite (200+ lignes)
│      ├─ initializeDatabase()
│      ├─ addWarning()
│      ├─ getWarningCount()
│      ├─ resetWarnings()
│      └─ getGroupWarnings()
│
├── 📁 utils/
│   └── helpers.js
│       └─ Fonctions utilitaires (150+ lignes)
│          ├─ isAdmin()
│          ├─ extractMessage()
│          ├─ containsUrl()
│          ├─ getGroupId()
│          ├─ isGroupMessage()
│          └─ formatMention()
│
├── 📁 handlers/
│   └─ (Répertoire pour modules additionnels)
│
├── 📁 auth_info_multi/
│   ├─ creds.json            (Credentials chiffrées)
│   ├─ pre-keys.json         (Pre-keys Signal)
│   └─ keys/                 (Clés de session)
│
├── 📄 botdata.db
│   └─ Base de données SQLite
│       └─ Table: warnings
│
├── 📄 package.json          (Dépendances npm)
├── 📄 README.md             (Intro rapide)
├── 📄 GUIDE_INTEGRATION.md  (Guide complet)
├── 📄 TEST_GUIDE.md         (Guide de test)
├── 📄 CONFIG_GUIDE.md       (Guide de config)
├── 📄 ARCHITECTURE.md       (Ce fichier)
└── 📄 .gitignore
```

---

## 🔄 Cycle de Vie Complet

```
[STARTUP]
    ↓
┌─────────────────────────────────┐
│ npm start                       │
│ • Initialise DB                 │
│ • Crée Socket Baileys           │
│ • Affiche QR code               │
└─────────┬───────────────────────┘
          ↓
┌─────────────────────────────────┐
│ ATTENTE DE SCAN QR              │
│ • QRTimeout: 60 secondes        │
│ • Scanner avec WhatsApp         │
└─────────┬───────────────────────┘
          ↓
┌─────────────────────────────────┐
│ HANDSHAKE WHATSAPP              │
│ • Noise protocol                │
│ • Pairing keys exchange         │
│ • Authenticate device           │
└─────────┬───────────────────────┘
          ↓
┌─────────────────────────────────┐
│ CONNEXION ÉTABLIE               │
│ isConnected = true              │
│ ✅ Bot connecté avec succès!    │
└─────────┬───────────────────────┘
          ↓
┌─────────────────────────────────┐
│ MODE PRODUCTION                 │
│ Écoute des événements:          │
│ • messages.upsert               │
│ • groups.update                 │
│ • connection.update             │
│ • creds.update                  │
└─────────┬───────────────────────┘
          ↓
     ┌────┴────┐
     │   LOOP : │
     │ Attendre │
     │  les     │
     │  événem. │
     └────┬────┘
          ↓
   ┌──────────────────┐
   │ Événement reçu   │
   │ Traiter          │
   │ Mettre à jour DB │
   └────┬─────────────┘
        │
        └─ (Répéter)
```

---

## 🚀 Points d'Intégration Externes

```
┌─────────────────────────────────────────────────────────────┐
│               BOT WHATSAPP (Baileys)                         │
└────────┬────────────────────────────────┬──────────────────┘
         │                                │
         ▼                                ▼
┌─────────────────────┐        ┌──────────────────────┐
│  WhatsApp Servers   │        │  Terminal / Console  │
│  (Envoyer/Recevoir) │        │  (Afficher QR, logs) │
├─────────────────────┤        └──────────────────────┘
│ • Messages          │
│ • Groupe métadonnées│
│ • Notifications     │
│ • Authentification  │
└─────────────────────┘
         ↑
         │ (Protocole Noise)
         │
   websocket://...
```

---

## 📊 Matrice de Responsabilités

| Module | Responsabilité | Fonction Clé | Événements |
|--------|----------------|--------------|-----------|
| **index.js** | Orchestration, socket | initializeSocket() | connection.update |
| **Handlers** | Traitement logique | handleNewMessages() | messages.upsert |
| **Anti-Lien** | Détection URLs | handleAntiLink() | message contient http/https |
| **Warnings** | Accumulation | addWarning() | Infraction détectée |
| **Kick** | Exclusion | handleUserKick() | count == 3 |
| **db.js** | Persistance | CRUD operations | saveDatabase() |
| **helpers.js** | Utilitaires | isAdmin(), extractMessage() | Utility call |

---

## 🔍 Flux de Données - Exemple Concret

```
Utilisateur envoie : "Regardez https://example.com"
                     │
                     ▼
            events: messages.upsert
                     │
            ┌────────┴────────┐
            ▼                 ▼
      handleNew       extracted:
      Messages()      "Regardez https://ex..."
            │                │
            └────────┬───────┘
                     ▼
            extractMessage(msg)
                     │
            ┌────────┴────────┐
            ▼                 ▼
       text found      isGroupMessage?
            │            YES ↓
            ▼                │
         "Regardez       groupMetadata(jid)
         https://..."       │
                            ▼
                      ┌──────────────┐
                      │ groupData =  │
                      │ {            │
                      │ participants │
                      │ subject      │
                      │ ...          │
                      │ }            │
                      └──────┬───────┘
                             ▼
                      containsUrl()?
                             │
                             ▼ YES
                      isAdmin(senderId)
                             │
                             ▼ NO
                      handleAntiLink()
                             │
            ┌────────────────┼────────────────┐
            ▼                ▼                ▼
        SUPPRIME       AJOUTE WARNING       ENVOIE MSG
        deleteMessage  addWarning(db,
                       groupId, userId)
                             │
                             ▼
                      getWarningCount
                             │
                             ▼ == 3?
                      handleUserKick()
                             │
            ┌────────────────┼────────────────┐
            ▼                ▼                ▼
        RETIRE(KICK) RÉINITIALISE    ENVOIE ALERTE
        groupParticipants resetWarnings    (all)
        Update()                      
```

---

## 🎯 Patterns et Best Practices utilisés

### 1. **Event-Driven Architecture**
```javascript
sock.ev.on('messages.upsert', handleNewMessages);
sock.ev.on('connection.update', handleConnectionUpdate);
```

### 2. **Async/Await Pattern**
```javascript
async function handleNewMessages(m) {
  for (const msg of m.messages) {
    const groupData = await sock.groupMetadata(jid);
    // ...
  }
}
```

### 3. **Error Handling (Try/Catch)**
```javascript
try {
  // Opérations critiques
} catch (error) {
  console.error('❌ Erreur:', error);
}
```

### 4. **Separation of Concerns**
- `index.js` : Logique métier
- `db.js` : Persistance
- `helpers.js` : Utilitaires

### 5. **Lazy Loading de Configuration**
```javascript
const CONFIG = { ... };  // Centralisé
```

---

## 🏁 Conclusion

Le bot fonctionne selon ce cycle :

1. **Démarrage** → Initialise DB et Socket
2. **Authentification** → QR code / Session persistante
3. **Écoute** → Reçoit les événements WhatsApp
4. **Traitement** → Applique les règles de modération
5. **Persistance** → Sauvegarde en SQLite
6. **Feedback** → Envoie les messages de retour
7. **Boucle infinie** → Répète 3-6 continuellement

---

**Architecture complète !** 🚀
