# 🏰 PARADIS EMPIRE BOT — SYSTEM ARCHITECTURE & CODE MAP

> **Ce fichier sert de vue d'ensemble et de carte de référence pour l'architecture du projet.**  
> Il doit être mis à jour à chaque amélioration pour permettre une compréhension instantanée de l'état du projet sans avoir à relire l'intégralité du code source.

---

## 1. Vue d'Ensemble & Stack Technique

* **Moteur WhatsApp :** `@whiskeysockets/baileys` (Multi-Device, WebSocket client WhatsApp Web).
* **Serveur & Interface Web :** `Express.js` (Port `process.env.PORT || 3000`), SSE (`Server-Sent Events`) pour les logs en temps réel.
* **Base de Données :** SQLite via `sql.js` (Fichier `botdata.db`).
* **Gestion Multi-Comptes :** Sessions isolées dans le dossier `./sessions/<phone>/` avec `useMultiFileAuthState`.
* **Hébergement :** Déploiement automatique sur **Render** via la branche `main` de GitHub.

---

## 2. Structure des Fichiers

| Fichier / Dossier | Rôle principal |
| :--- | :--- |
| `index.js` (~6300 lignes) | Cœur du bot : gestionnaire de socket Baileys, routage des commandes, modules de défense, serveur Express. |
| `db.js` (~520 lignes) | Couche de données SQLite : gestion des warnings, sudos, allowed users, blacklist permanente, settings. |
| `botdata.db` | Fichier de base de données SQLite physique persistant les états. |
| `public/` | Interface Web du Dashboard : `index.html`, `app.js`, `admin.html`, `comptes.html`, `style.css`. |
| `public/blacklist.vcf` | Fichier de contacts vCard 3.0 contenant la liste noire globale (`FN:مؤبد//مبند`). |
| `sessions/` | Répertoires d'authentification Baileys pour chaque numéro WhatsApp connecté. |

---

## 3. Carte de Code `index.js` (Index des Lignes & Fonctions)

* **Lignes 1 - 200 :** Imports, configuration de base, caches mémoire (`groupMetadataCache`, `botDeviceCheckCache`, `groupBlacklistCheckCooldown`, etc.), listes noires en dur (`BLACKLISTED_TABNEED_NUMBERS`).
* **Lignes 201 - 650 :** Gestion du cycle de vie des sessions Baileys (`createSession`, reconnexion, gestion QR et Pairing Code, keep-alive de présence).
* **Lignes 651 - 1000 :** Réception des messages (`messages.upsert` -> `handleSessionMessages`), filtrage précoce de la blacklist, résolution des LIDs en numéros réels.
* **Lignes 1001 - 1800 :**
  - Protection Anti-Tabneed & Anti-Ban Group (`isTabneedCmd`).
  - Routage des commandes (`.menu`, `.status`, `.deploy`, `.scan`, `.kick`, `.ban`, `.blacklistontact`, etc.).
  - Sécurité des expulsions (`safeGroupParticipantsRemove`).
* **Lignes 1801 - 2500 :**
  - Vérification & purge Blacklist (`checkAndPurgeBlacklistInGroup`).
  - Module de défense Tabneed / Crash / Exploit (`handleTabneedCommandAttempt`).
  - Défense Sudo (`handleSudoDefense`).
* **Lignes 2501 - 3050 :**
  - Module Anti-Bot & détection d'appareils liés via USync (`checkUserHasLinkedDevices`, `executeAntiBotBatchProcedure`).
  - Surveillance des entrées de groupe (`handleAntiBotParticipantCheck`).
* **Lignes 3051 - 4200 :**
  - Gestionnaires de commandes d'administration et Sudo (`handleHelpCommand`, `handleBlacklistCommand`, `handleBlacklistContactCommand`, `handleBanCommand`, `handleUnbanCommand`, `handleDeployCommand`).
* **Lignes 4201 - 5600 :**
  - Scanner manuel (`handleScanCommand`), gestion des requêtes d'adhésion (`handleRequestsCommand`), Anti-Lien, Anti-Contact, Anti-Spam.
* **Lignes 5601 - 6140 :**
  - Routes API Express (`/api/sessions`, `/api/deploy`, `/api/logs`, etc.) et interface statique.
* **Lignes 6141 - 6330 :**
  - Scanner périodique d'arrière-plan (`startPeriodicAntiBotScanner`).
  - Point d'entrée de démarrage (`startServer`).

---

## 4. Modules de Sécurité & Règles d'Or

### A. Protection Anti-Ban & Pression Serveur (Allègement des requêtes)
1. **Scanner périodique (10 minutes) :**
   - Ne tourne plus toutes les 20 secondes, mais toutes les **10 minutes** (`600 000 ms`).
   - Utilise le cache mémoire des groupes (`groupMetadataCache`) pour éviter de solliciter `groupFetchAllParticipating` en permanence.
   - Ignore les participants déjà vérifiés il y a moins de 30 minutes (`botDeviceCheckCache`).
   - Temporisation de 1.5s entre chaque groupe et 1.2s entre les paquets USync.
2. **Filtrage des commandes malveillantes (Préfixe obligatoire) :**
   - Un utilisateur qui écrit `ban` ou `demoteall` dans une conversation ordinaire n'est **jamais** inquiété.
   - Seuls les messages commençant par un préfixe de commande (`.`, `!`, `/`, `#`) comme `.ban`, `.banbg`, `.bangb`, `.tabneed`, `.crash`, `.nuke` sont interceptés et neutralisés.
3. **Throttling Blacklist dans les groupes :**
   - `checkAndPurgeBlacklistInGroup` possède un cooldown de **3 minutes** par groupe sur les messages ordinaires pour éviter de scanner la liste des participants à chaque message.
4. **Cache 15 min Anti-Bot sur les messages :**
   - Lors de la réception de messages ordinaires, `checkUserHasLinkedDevices` utilise le cache local (`forceFresh = false`) sans interroger les serveurs Meta.
5. **Kicks silencieux Anti-Bot (Suppression de `وينو عندو بوت`) :**
   - L'expulsion groupée d'Anti-Bot ne publie plus de message textuel taguant les membres avant le kick. Cela élimine les requêtes de messages sortants et évite que les membres expulsés ne signalent ("Report") le compte du bot.

### B. Protection Sudo & Immunité
- Les membres de la liste **Sudo** (`isSudo()`) et de la **Whitelist Permanente** (`isPermanentWhitelisted()`) sont protégés à 100% :
  - Impossibles à kicker, demote ou blacklister.
  - Autorisés à utiliser des appareils liés (WhatsApp Web / PC / Bot).
  - Immunisés contre l'anti-lien, l'anti-spam et l'anti-contact.
- En cas de tentative d'expulsion d'un Sudo par un admin non-sudo, le bot révoque instantanément l'admin (`handleSudoDefense`).

### C. Blacklist Globale & Contacts VCF
- Les numéros blacklistés sont exclus automatiquement dès qu'ils envoient un message, rejoignent un groupe ou sont détectés lors du scan.
- Commande `.blacklistontact` : exporte tous les contacts de la liste noire dans un fichier `blacklist_contacts.vcf` où chaque contact est nommé **`مؤبد//مبند`**.

---

## 5. Journal des Dernières Modifications

* **2026-11-11 : Harmonisation des messages de détection (WhatsApp Web)**
  - Remplacement des mentions "Robot / Bot" dans les résultats `.scan`, `.requests` et alertes d'adhésion par la mention explicite : `يستخدم فقط واتساب ويب (WhatsApp Web)`.
  - Explication des limites protocolaires : WhatsApp ne fournissant aucun tag "Windows/Mac/Linux" aux tiers, la distinction automatique par OS est impossible côté protocole ; la modération s'appuie sur la Trust List et le statut de modération (`.antibot on/off`).

* **2026-11-10 : Mise à jour de la Sudo List & Trust List Permanente**
  - Ajout des numéros à la Sudo List et Trust List permanente : `+212788991779`, `+212626388283`, `+212709439701`, `+212699917192`, `+212607843575`.
  - Retrait des numéros révoqués : `+212717716959`, `+212775395922`, `+212701645211`, `+212656476122`.
  - Confirmation du statut Trust List : tout membre de la Sudo List bénéficie automatiquement de 100% d'immunité et d'autorisation des linked devices.

* **2026-11-09 : Allègement drastique de la pression réseau (Anti-Ban du numéro WhatsApp)**
  - Augmentation de l'intervalle du scanner en arrière-plan de **20 secondes à 10 minutes**.
  - Remplacement des requêtes `groupFetchAllParticipating` systématiques par l'utilisation intelligente de `groupMetadataCache`.
  - Restriction de la détection Anti-Tabneed aux messages avec préfixe (`.ban`, `.banbg`, `.bangb`, etc.), permettant aux utilisateurs de discuter avec le mot `ban` sans faux positif.
  - Ajout d'un cooldown de 3 minutes sur `checkAndPurgeBlacklistInGroup` lors du flux de messages normal.
  - Activation du cache local 15 min sur `checkUserHasLinkedDevices` dans le module Anti-Bot en temps réel.
  - Suppression de l'envoi du message `(وينو عندو بوت)` avant les expulsions Anti-Bot pour supprimer les signalements d'utilisateurs et économiser les messages sortants.
  - Création du fichier de bord architectural `PROJECT_OVERVIEW.md`.

