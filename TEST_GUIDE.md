# 🧪 Guide de Test Pratique du Bot

## ✅ Checklist de Démarrage

### Avant de Tester

- [ ] Node.js v16+ installé
- [ ] Téléphone WhatsApp à proximité
- [ ] Bot mis en tant qu'admin du groupe
- [ ] Terminal ouvert à `c:\Users\DELL\Desktop\WebProjectFs\BotWhatsapp`

### Démarrer

```bash
npm start
```

Résultat attendu :
```
🚀 Initialisation du bot WhatsApp...
✅ Base de données initialisée avec succès
✅ Socket WhatsApp initialisée avec succès
🎉 Bot prêt et en attente de messages...
⏳ Connexion en cours...
📱 Scannez ce QR code avec votre téléphone WhatsApp:
[QR CODE AFFICHÉ]
```

---

## 🧪 Tests à Effectuer

### Test 1 : Authentification

**Objectif :** Connecter le bot à WhatsApp

**Étapes :**
1. ✅ Voir le QR code dans le terminal
2. ✅ Ouvrir WhatsApp → Paramètres → Appareils liés
3. ✅ Scanner le QR code avec le téléphone
4. ✅ Attendre 30 secondes

**Résultat attendu :**
```
✅ Bot connecté avec succès!
🎉 Bot prêt et en attente de messages...
```

---

### Test 2 : Anti-Lien (Non-Admin)

**Scénario :** Utilisateur non-admin envoie un lien

#### 2A - Premier Lien (1er Warning)

**Étapes dans le groupe :**
1. Gardez le bot dans la même ligne de vision
2. **Envoyer un message** : `Regardez ça: https://example.com`
3. **Observer immédiatement** → Le message doit disparaître en 2-3 secondes

**Résultat attendu - Terminal :**
```
📝 Anti-lien: Message supprimé, warning #1 pour [utilisateur]
```

**Résultat attendu - Groupe WhatsApp :**
```
Bot: ⚠️ @212612345678 Lien détecté et supprimé! Warning 1/3
```

#### 2B - Deuxième Lien (2e Warning)

**Envoyer :** `Voici un autre lien: http://test.com`

**Résultat expecté :**
```
Bot: ⚠️ @212612345678 Lien détecté et supprimé! Warning 2/3
```

#### 2C - Troisième Lien (EXCLUSION)

**Envoyer :** `Dernier lien: https://spam.com`

**Résultat attendu :**
```
Bot: ⚠️ @212612345678 Lien détecté et supprimé! Warning 3/3

Bot: 🚫 @212612345678 a été exclu du groupe (3 warnings atteints)
```

**Vérification :** Regardez la liste du groupe → Utilisateur disparu ✅

---

### Test 3 : Anti-Lien (Admin)

**Objectif :** Vérifier que les admins peuvent poster des liens

**Étapes (en tant qu'admin du groupe) :**
1. **Envoyer :** `Documentation importante: https://docs.example.com`
2. **Observer** → Le message **NE DOIT PAS** être supprimé

**Résultat attendu :**
```
✅ Message visible et non supprimé
❌ Aucun warning ajouté
❌ Aucun message du bot
```

---

### Test 4 : Commande `!warn` (Admin)

**Objectif :** Tester l'ajout manual de warnings par un admin

#### 4A - Syntaxe Correcte

**En tant qu'admin, envoyer :** `!warn @212612345678`

(Remplacez `212612345678` par le vrai numéro)

**Résultat attendu :**
```
Bot: ✅ Warning ajouté pour @212612345678. Total: 1/3
```

#### 4B - Commande Invalide

**Envoyer :** `!warn invalid`

**Résultat attendu :**
```
Bot: ❌ Syntaxe incorrecte. Utilisez: !warn @numéro
```

#### 4C - Accès Non-Admin

**En tant que non-admin, envoyer :** `!warn @212612345678`

**Résultat attendu :**
```
❌ Aucun réaction du bot (commande ignorée)
```

---

### Test 5 : Accumulation et Exclusion

**Objectif :** Tester l'exclusion après 3 warnings

#### Étape 1 : Ajouter 2 warnings via commande

```
Admin: !warn @212612345678
Bot: ✅ Warning ajouté pour @212612345678. Total: 1/3

Admin: !warn @212612345678
Bot: ✅ Warning ajouté pour @212612345678. Total: 2/3
```

#### Étape 2 : Déclencher le 3e warning via lien

```
@212612345678: https://spam.com
Bot: ⚠️ @212612345678 Lien détecté et supprimé! Warning 3/3
Bot: 🚫 @212612345678 a été exclu du groupe (3 warnings atteints)
```

**Vérification :** Utilisateur disparu du groupe ✅

---

### Test 6 : Base de Données

**Objectif :** Vérifier les données stockées

#### Option 1 : Vérifier Directement

Ouvrez `botdata.db` avec un outil SQLite (DB Browser for SQLite, etc.)

```sql
SELECT * FROM warnings;
```

**Résultat expecté :**
```
| groupId         | userId                  | count |
|-----------------|-------------------------|-------|
| 120123@g.us     | 212612345678@s.... | 0     | (réinitialisé après kick)
| 120123@g.us     | 212698765432@s.... | 2     | (en cours)
```

#### Option 2 : Via Terminal Node.js

```bash
node -e "
import('./db.js').then(db => {
  console.log(db.getGroupWarnings('VOTRE_GROUP_ID'));
});
"
```

---

## 📊 Tableau Récapitulatif des Tests

| Test | Action | Résultat Attendu | Statut |
|------|--------|------------------|--------|
| Auth | Scanner QR | Bot connecté ✅ | ⏳ |
| Anti-Lien Non-Admin #1 | Envoyer lien | Message supprimé + Warning 1/3 | ⏳ |
| Anti-Lien Non-Admin #2 | Envoyer lien | Message supprimé + Warning 2/3 | ⏳ |
| Anti-Lien Non-Admin #3 | Envoyer lien | Message supprimé + Warning 3/3 + EXCLUSION | ⏳ |
| Anti-Lien Admin | Envoyer lien | Message autorisé, pas de warning | ⏳ |
| Cmd !warn Admin | `!warn @user` | Warning ajouté | ⏳ |
| Cmd !warn Non-Admin | `!warn @user` | Ignoré | ⏳ |
| Cmd Syntaxe Invalide | `!warn invalid` | Message d'erreur | ⏳ |
| DB Persistence | Relancer bot | Les warnings persistent | ⏳ |

---

## 🔍 Debug - Comment Lire les Logs

### Logs Anti-Lien

```
📝 Anti-lien: Message supprimé, warning #2 pour 212612345678@s.whatsapp.net
```

**Décodage :**
- `Anti-lien` → Trigger : détection d'URL
- `warning #2` → C'est le 2e warning
- `212612345678@s.whatsapp.net` → JID (identifiant unique) de l'utilisateur

### Logs Commandes

```
📝 Commande !warn: Warning #1 pour 212612345678@s.whatsapp.net
```

### Logs Exclusion

```
🚫 Utilisateur 212612345678@s.whatsapp.net exclu du groupe 123456789@g.us
```

---

## ⚠️ Problèmes Courants et Solutions

### Problème 1 : QR Code ne s'affiche pas

**Cause :** Terminal incompatible ou version Node trop ancienne

**Solution :**
```bash
# Vérifier Node.js
node --version  # Doit être v16+

# Essayer un autre terminal
# - Git Bash
# - WSL2
# - Command Prompt (au lieu de PowerShell)
```

### Problème 2 : Messages pas supprimés

**Cause :** Bot n'a pas les droits d'admin

**Solution :**
1. Ouvrir le groupe WhatsApp
2. Infos du groupe → Admins
3. Ajouter le bot en tant qu'admin

### Problème 3 : Commande `!warn` ne fonctionne pas

**Cause :** Vous n'êtes pas admin

**Solution :**
- Vérifier votre statut d'admin dans le groupe
- Ou utiliser l'anti-lien (automatique)

### Problème 4 : Utilisateurs ne sont pas expulsés

**Cause :** Bot n'a pas les droits de gestion des membres

**Solution :**
1. Groupe → Infos
2. Permissions du groupe
3. "Qui peut supprimer des messages ?" → Admins
4. "Qui peut éditer les infos du groupe ?" → Admins

### Problème 5 : Erreur "Could not locate bindings"

**Cause :** Problème avec les dépendances natives

**Solution :**
```bash
npm install --ignore-scripts
```

---

## 📝 Checklist de Validation Finale

Avant de dire que le bot est "prêt" :

- [ ] QR Code s'affiche et se scanne correctement
- [ ] Bot se connecte à WhatsApp (`✅ Bot connecté`)
- [ ] Premier lien déclenche une suppression
- [ ] Premier lien déclenche un warning (1/3)
- [ ] Bot can être tag avec `@bot-whatsapp`
- [ ] 3 warnings causent une exclusion
- [ ] Les admins peuvent poster des liens
- [ ] La commande `!warn` fonctionne (admin)
- [ ] La commande `!warn` est ignorée (non-admin)
- [ ] Les données persistent après redémarrage

**Si tous les éléments sont ✅ → Bot Fonctionnel ! 🎉**

---

## 🎓 Prochaines Étapes

Après validation, vous pouvez :

1. **Ajouter une whitelist de groupes** → Modérer plusieurs groupes
2. **Créer un dashboard web** → Voir les stats en temps réel
3. **Ajouter des commandes** → `!list`, `!reset`, `!stats`
4. **Filtrer le spam** → Au-delà des simples liens
5. **Notifier les admins** → Dans un groupe "modos" séparé

Consultez `GUIDE_INTEGRATION.md` pour plus de détails ! 🚀
