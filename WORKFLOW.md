# 📊 Workflows - Scénarios d'Utilisation

Ce document montre les différents scénarios d'utilisation et ce que le bot fait dans chaque cas.

---

## 🔄 Workflow 1 : Démarrage du Bot

```
UTILISATEUR                          BOT
    │                                │
    ├─ npm start ────────────────────┤
    │                                ├─ Charge la DB (botdata.db)
    │                                ├─ Initialise Baileys Socket
    │                                └─ Attendre connexion
    │                                │
    │◄─────── Affiche QR Code ───────┤
    │        (dans le terminal)      │
    │                                │
    ├─ Scanner QR avec téléphone ────┤
    │                                ├─ Échange clés de pairing
    │                                ├─ Authentifie l'appareil
    │                                └─ Établit la connexion
    │                                │
    │◄─────── Message ✅ Connecté ────┤
    │                                │
    │        [Bot Opérationnel]      │
    │                                │
    └─────────────────────────────────┘
```

---

## 🔗 Workflow 2 : Anti-Lien (Cas Nominal)

```
GROUPE WHATSAPP                      BOT
    │                                │
    ├─ Non-admin envoie link ───────┤
    │  "La vidéo: https://..." │
    │                                ├─ Reçoit l'event
    │                                ├─ Extrait le texte
    │                                ├─ Détecte URL (https://)
    │                                ├─ Vérifie les droits ... FAIL
    │                                │
    │◄─ Message supprimé ──────────┤
    │  (disparaît immédiatement)    ├─ Ajoute 1 warning en DB
    │                                ├─ Récupère le total (1/3)
    │                                └─ Envoie une alerte
    │                                │
    │ 🤖 Bot: "⚠️ Lien détecté!" │
    │         Warning 1/3           │
    │                                │
    └─────────────────────────────────┘
```

---

## 👑 Workflow 3 : Anti-Lien (Admin)

```
GROUPE WHATSAPP                      BOT
    │                                │
    ├─ Admin envoie link ───────────┤
    │  "Lecture: https://..." │
    │                                ├─ Reçoit l'event
    │                                ├─ Extrait le texte
    │                                ├─ Détecte URL (https://)
    │                                ├─ Vérifie les droits ... OK ✓
    │                                │
    │✅ Message visible ────────────┤
    │  (pas de suppression)         └─ Rien ne se passe
    │                                │
    │  → Pas de warning             │
    │  → Pas d'alerte               │
    │                                │
    └─────────────────────────────────┘
```

---

## ⚠️ Workflow 4 : Accumulation de Warnings

```
Timeline:
─────────────────────────────────────────────────────────────

JOUR 1 - Premier Lien
│
├─ Non-admin envoie URL
│  ↓ Bot: "⚠️ Warning 1/3"
│  DB: count = 1
│
├─ Utilisateur continue quand même
│
JOUR 2 - Deuxième Lien
│
├─ Non-admin envoie URL (pas appris !)
│  ↓ Bot: "⚠️ Warning 2/3"
│  DB: count = 2
│
├─ Utilisateur "oublie" les règles
│
JOUR 3 - Troisième Lien (CRITIQUE!)
│
├─ Non-admin envoie URL
│  ↓ Bot: "⚠️ Warning 3/3"
│  ↓ [BOOM] EXCLUSION AUTOMATIQUE
│  ├─ Retire l'utilisateur du groupe
│  ├─ Réinitialise son count (DB: count = 0)
│  └─ Envoie une alerte au groupe
│
└─ 🚫 Utilisateur disparu ...
   (en attente d'une rédemption par un admin)

─────────────────────────────────────────────────────────────
```

---

## 💬 Workflow 5 : Commande `!warn`

### Cas Que Fonctionne (Admin)

```
GROUPE WHATSAPP                      BOT
    │                                │
    ├─ Admin envoie cmd ───────────┤
    │  "!warn @212612345678"      │
    │                                ├─ Reçoit le message
    │                                ├─ Détecte "!warn" au début
    │                                ├─ Vérifie: Admin? OUI ✓
    │                                ├─ Parse le numéro
    │                                ├─ Vérifie dans le groupe... OK
    │                                ├─ Ajoute 1 warning
    │                                └─ Récupère le total
    │                                │
    │ 🤖 Bot: "✅ Warning ajouté!"  │
    │         Total: 1/3            │
    │                                │
    └─────────────────────────────────┘
```

### Cas Qui Échoue (Non-Admin)

```
GROUPE WHATSAPP                      BOT
    │                                │
    ├─ Non-admin envoie cmd ───────┤
    │  "!warn @212612345678"      │
    │                                ├─ Reçoit le message
    │                                ├─ Détecte "!warn"
    │                                ├─ Vérifie: Admin? NON ✗
    │                                │
    │ ❌ Commandeignorée ────────────┤
    │  (aucune réaction)            └─ Rien ne se passe
    │                                │
    └─────────────────────────────────┘
```

---

## 🚫 Workflow 6 : Exclusion Automatique

```
                    ┌─────────────────────┐
                    │ État: 3 Warnings    │
                    │ Utilisateur = 🎯    │
                    └──────────┬──────────┘
                               │
                               ▼
                    ┌─────────────────────┐
                    │ Nouvelle infraction │
                    │ (lien ou cmd)       │
                    └──────────┬──────────┘
                               │
                               ▼
            ┌──────────────────────────────────┐
            │ DÉCLENCHEMENT DE L'EXCLUSION    │
            │ (handleUserKick)                │
            └──────────────┬───────────────────┘
                           │
        ┌──────────────────┼──────────────────┐
        │                  │                  │
        ▼                  ▼                  ▼
    ┌────────┐      ┌──────────────┐    ┌─────────┐
    │ Envoyer│      │Retirer de     │    │ Réinitia-│
    │ alerte │      │groupParticipan│    │liser DB │
    │ groupe │      │tsUpdate()     │    │ count=0 │
    └────────┘      └──────────────┘    └─────────┘
        │                  │                  │
        └──────────────────┼──────────────────┘
                           │
                           ▼
                  ┌─────────────────────┐
                  │ ✅ Exclusion Complète│
                  │ (membre disparu)    │
                  └─────────────────────┘
```

**Message envoyé au groupe :**
```
🚫 @212612345678 a été exclu du groupe (3 warnings atteints)
```

---

## 📱 Workflow 7 : Cycle de Reconnexion

```
                        [Bot En Marche]
                              │
                              ▼
                    ┌─────────────────────┐
                    │ Connexion Stable    │
                    │ isConnected = true  │
                    └──────────┬──────────┘
                               │
                    ┌──────────┴──────────┐
                    │                     │
                    │                     ▼
                    │            ┌─────────────────┐
                    │            │ Perte réseau    │
                    │            │ ou déco WA      │
                    │            └────────┬────────┘
                    │                     │
                    │                     ▼
                    │            ┌─────────────────┐
                    │            │ connection = close
                    │            │ isConnected=false│
                    │            └────────┬────────┘
                    │                     │
                    │                     ▼
                    │            ┌─────────────────┐
                    │            │ Tentative       │
                    │            │ reconnexion ... │
                    │            │ (3 secondes)    │
                    │            └────────┬────────┘
                    │                     │
                    └─────────────────────┘
                              ▲
                              │
               ┌──────────────┴──────────────┐
               │                             │
         Succès                        Échec
               │                        │
               ▼                        ▼
        [Reconnexion OK]      [Attendre & Retry]
          Continuer                  (boucle)
```

---

## 🔍 Workflow 8 : Traitements d'Erreurs

```
ÉVÉNEMENT REÇU
    │
    ├─ Pas un groupe ? ──────────────► [IGNORÉ]
    │
    ├─ De moi (bot) ? ──────────────► [IGNORÉ]
    │
    ├─ Pas de message ? ────────────► [IGNORÉ]
    │
    ├─ Extraction texte échoue ? ───► [IGNORÉ]
    │
    ├─ Pas de groupe metadata ? ───► [ERROR - Log]
    │
    ├─ Anti-lien crash ? ──────────► [ERROR - Log]
    │                                [Continue]
    │
    └─ OK - Traiter
        │
        └─ Résultat: ✅ Success ou ⚠️ Warning
```

---

## 📊 Workflow 9 : Persistence de la Base de Données

```
DÉMARRAGE #1
    │
    ├─ Crée botdata.db
    ├─ Crée table warnings
    │
    ├─ Utilisateur A: 2 warnings
    └─ Sauvegarde: botdata.db (fichier)

                    | [Bot Redémarrage] |

DÉMARRAGE #2
    │
    ├─ Charge botdata.db existant
    ├─ Tous les warnings persistent ✓
    │
    ├─ Utilisateur A: toujours 2 warnings
    │
    ├─ Fait un 3e lien
    │ └─ EXCLUSION (total = 3)
    │
    └─ Sauvegarde: botdata.db (mis à jour)

                    | [Bot Redémarrage] |

DÉMARRAGE #3
    │
    ├─ Charge botdata.db existant
    ├─ Utilisateur A: 0 warnings (réinitialisé)
    │
    └─ [L'historique persiste 🎯]
```

---

## 🎯 Workflow 10 : Scénario Réaliste Complet

```
T=0:00   [Somoza ouvre le bot]
         npm start
         │
         ├─ ✅ DB initialisée
         ├─ ✅ Socket créée
         └─ 📱 QR code affiché

T=0:30   [Somoza scanne le QR]
         │
         ├─ ✅ WhatsApp authentifie
         └─ ✅ Bot connecté

T=1:00   [Alice (non-admin) envoie vidéo YouTube]
         │
         ├─ 🤖 Message supprimé
         ├─ DB: Alice count = 1
         └─ 📢 "⚠️ Lien détecté! 1/3"

T=1:30   [Bob (admin) envoie un lien doc]
         │
         ├─ ✅ Message visible (admin autorisé)
         └─ 📄 Pas de warning

T=2:00   [Alice envoie un 2e lien]
         │
         ├─ 🤖 Message supprimé
         ├─ DB: Alice count = 2
         └─ 📢 "⚠️ Lien détecté! 2/3"

T=3:00   [Charlie (non-admin) teste]
         │
         ├─ 🤖 Message supprimé
         ├─ DB: Charlie count = 1
         └─ 📢 "⚠️ Lien détecté! 1/3"

T=4:00   [Alice envoie un 3e lien]
         │
         ├─ 🤖 Message supprimé
         ├─ DB: Alice count = 3 ← LIMITE ATTEINTE!
         │
         ├─ 🚫 EXCLUSION DÉCLENCHÉE:
         │   • Alice retirée du groupe
         │   • DB: Alice count = 0 (reset)
         │   • 📢 "🚫 Alice exclu du groupe (3 avertissements)"
         │
         └─ ✅ Modération complète

T=4:30   [Admin Jessica utilise !warn]
         │
         ├─ "!warn @212634567" (Charlie)
         │
         ├─ 📢 "✅ Warning ajouté pour @212634567"
         ├─ DB: Charlie count = 2
         │
         └─ (Charlie a maintenant 1 infraction de plus)

[Fin du scénario]

Logs générés:
├─ 📝 Anti-lien: Message supprimé, warning #1 pour Alice
├─ 📝 Anti-lien: Message supprimé, warning #2 pour Alice
├─ 📝 Anti-lien: Message supprimé, warning #1 pour Charlie
├─ 🚫 Utilisateur Alice exclu du groupe
└─ 📝 Commande !warn: Warning #2 pour Charlie
```

---

## 🎓 Conclusion

Ces workflows montrent :

✅ **Comment le bot se connecte**
✅ **Comment il détecte les violations**
✅ **Comment il penalise progressivement**
✅ **Comment il exclut après 3 warnings**
✅ **Comment il persiste les données**
✅ **Comment il gère les reconnexions**
✅ **Comment il commande les erreurs**

Le bot est robuste, persistant, et automatisé ! 🚀

---

**Pour plus de détails, consulte GUIDE_INTEGRATION.md** 📚
