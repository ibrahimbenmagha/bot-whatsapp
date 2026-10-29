# ⚡ Démarrage Ultra-Rapide (5 minutes)

Tu veux juste que ça marche ? Suis ces 5 étapes !

---

## 🚀 Les 5 Étapes pour Démarrer

### Étape 1 : Lance le Bot (30 secondes)

```bash
cd c:\Users\DELL\Desktop\WebProjectFs\BotWhatsapp
npm start
```

**Attends que tu vois :**
```
🎉 Bot prêt et en attente de messages...
⏳ Connexion en cours...
```

---

### Étape 2 : Scanner le QR Code (1 minute)

Tu devrais voir un **QR code** dans le terminal.

**Fais ceci sur ton téléphone :**

1. Ouvre **WhatsApp**
2. Appelle **Paramètres** (⚙️)
3. Cherche `Appareils liés` ou `Lien WhatsApp` ou `WhatsApp Web`
4. Tape **"Lier un appareil"**
5. **Scanner le QR code** avec la caméra

---

### Étape 3 : Attendre la Connexion (30 secondes)

Un fois le QR scanné, le terminal affichera :

```
✅ Bot connecté avec succès!
🎉 Bot prêt et en attente de messages...
```

**Le bot est maintenant online ! ✅**

---

### Étape 4 : Personnaliser le Groupe Cible (1 minute)

Édite `index.js` (ligne 17) :

**Avant :**
```javascript
targetGroupName: 'Votre Nom du Groupe',
```

**Après (exemple) :**
```javascript
targetGroupName: 'Modération Test',  // ← Remplace par le vrai nom
```

**Rédemarre le bot :**
```bash
npm start
```

---

### Étape 5 : Test Rapide (2 minutes)

**Dans ton groupe WhatsApp :**

1. **Ajoute le bot en tant qu'admin** (si pas déjà fait)
2. **Envoie un lien** depuis un compte non-admin : `https://example.com`
3. **Regarde le message disparaître** en 2-3 secondes
4. **Le bot envoie un avertissement** : `⚠️ Lien détecté et supprimé! Warning 1/3`

**Succès ! 🎉**

---

## 📋 Ce que tu peux Faire Maintenant

| Action | Commande/Texte | Résultat |
|--------|---|--|
| Arrêter le bot | `Ctrl+C` (dans terminal) | Bot s'arrête |
| Redémarrer | `npm start` | Bot relancé |
| Test anti-lien | Envoyer un lien (non-admin) | Message supprimé |
| Avertissement manuel | `!warn @212612345678` | Warning ajouté (admin) |
| 3e infraction | 3 avertissements | Utilisateur exclu |

---

## 🆘 Ça Ne Marche Pas ?

### Problème 1 : Pas de QR Code

**Solution :**
```bash
# Supprimer la session existante
Remove-Item -Path "./auth_info_multi" -Recurse -Force

# Relancer
npm start
```

### Problème 2 : Message Non Supprimé

**Vérifier :**
- ✅ Bot est **admin** du groupe ?
- ✅ Tu utilises bien un **compte non-admin** pour envoyer le lien ?
- ✅ Le groupe cible correspond à `targetGroupName` dans `index.js` ?

### Problème 3 : Erreur lors du démarrage

```bash
# Réinstaller les dépendances
npm install
npm start
```

---

## 📚 Documentation Complète

Une fois que ça marche, explore :

- **[GUIDE_INTEGRATION.md](./GUIDE_INTEGRATION.md)** : Comment ça fonctionne en détail
- **[TEST_GUIDE.md](./TEST_GUIDE.md)** : Guide de test approfondi
- **[CONFIG_GUIDE.md](./CONFIG_GUIDE.md)** : Toutes les personnalisations
- **[ARCHITECTURE.md](./ARCHITECTURE.md)** : Schémas et diagrammes

---

## 🎓 Prochaines Étapes (Optionnel)

Après vous êtes sure que ça marche :

1. **Personnaliser les messages** (CONFIG_GUIDE.md)
2. **Modifier le nombre de warnings** (CONFIG_GUIDE.md)
3. **Ajouter d'autres filtres** (code dans `index.js`)
4. **Supporter plusieurs groupes** (ARCHITECTURE.md)

---

## ✅ Checklist Rapide

- [ ] `npm start` lancé
- [ ] QR code affiché
- [ ] QR code scanné avec WhatsApp
- [ ] Message `✅ Bot connecté`
- [ ] Bot défini en tant qu'admin du groupe
- [ ] Nom du groupe édité dans `index.js`
- [ ] npm start relancé
- [ ] Test anti-lien envoyé (non-admin)
- [ ] Message supprimé ? ✅
- [ ] Avertissement affiché ? ✅

**Si tout est ✅ → Tu as un Bot Fonctionnel ! 🎉**

---

## 🎯 Les Commandes à Retenir

```bash
npm start              # Lancer le bot
npm run dev            # Lancer avec hot-reload
Ctrl+C                 # Arrêter le bot
npm install            # Réinstaller les dépendances
```

---

**Happy Moderation ! 🚀**

Pour plus de détails, consulte les autres guides (lien en haut).
