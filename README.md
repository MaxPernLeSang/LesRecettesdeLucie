# Les recettes de Lucie — mise en ligne

Site des fiches techniques de Lucie, avec recalcul des grammages. Il est publié par GitHub Pages et
protégé par une connexion Google : seuls les deux comptes Google autorisés voient les recettes et
peuvent les modifier. Les recettes, dossiers et modifications sont dans une base Firebase (Firestore)
partagée : ce que Lucie change sur son téléphone apparaît chez Max, et inversement.

**Important :** ce dépôt ne contient aucune recette. Elles sont envoyées une seule fois dans la base
(étape 7) avec le fichier `recettes-initiales.json`, qu'il ne faut **pas** mettre sur GitHub
(un dépôt GitHub Pages gratuit est public).

Compter environ 20 minutes, une seule fois. Tout est gratuit (offre Spark de Firebase).

---

## 1. Créer le projet Firebase

1. Aller sur <https://console.firebase.google.com> avec votre compte Google, puis **Créer un projet**.
2. Nom : `recettes-lucie` (ou autre). Google Analytics : **désactivé**. Créer.

## 2. Récupérer la configuration et la coller dans le site

1. Sur la page d'accueil du projet, cliquer sur l'icône **Web** `</>` (« Ajouter une application »).
2. Surnom : `site`. Ne **pas** cocher Firebase Hosting. Enregistrer.
3. Firebase affiche un bloc `const firebaseConfig = { apiKey: "...", ... }`.
4. Ouvrir le fichier `firebase-config.js` de ce dossier (TextEdit suffit, en texte brut) et remplacer
   chaque `A_REMPLACER` par les valeurs affichées (apiKey, authDomain, projectId, storageBucket,
   messagingSenderId, appId). Enregistrer.

Ces valeurs ne sont pas secrètes : c'est normal qu'elles soient visibles sur GitHub.

## 3. Activer la connexion Google

1. Menu de gauche : **Créer > Authentication**, puis **Commencer**.
2. Onglet **Mode de connexion** : choisir **Google**, **Activer**, choisir votre adresse comme e-mail
   d'assistance, **Enregistrer**.

## 4. Autoriser l'adresse du site

Toujours dans Authentication : onglet **Paramètres > Domaines autorisés > Ajouter un domaine** :

```
maxpernlesang.github.io
```

## 5. Créer la base et la protéger

1. Menu de gauche : **Créer > Firestore Database**, puis **Créer une base de données**.
2. Emplacement : `eur3 (europe-west)` (ou une région européenne). Mode : **production**. Créer.
3. Onglet **Règles** : tout effacer, coller le contenu du fichier `firestore.rules`, puis remplacer
   `adresse.de.max@gmail.com` et `adresse.de.lucie@gmail.com` par vos deux adresses Gmail
   (en minuscules). Cliquer sur **Publier**.

Dans les règles, `ADMINS` (Max) gère les accès et `TOUJOURS` (Lucie) est toujours autorisée.

**Nouvelles personnes :** quelqu'un qui se connecte avec un autre compte Google envoie une demande
d'accès. Elle apparaît chez Max dans l'onglet **Accès** du site (avec une pastille), où il peut
**Autoriser**, **Refuser**, **Retirer l'accès** plus tard, ou autoriser une adresse à l'avance.
Une personne refusée ne voit aucune recette : c'est la base elle-même qui refuse.

## 6. Publier sur GitHub Pages

Les fichiers sont déjà dans ce dépôt. Il reste à :

1. Modifier `firebase-config.js` directement sur GitHub : ouvrir le fichier, crayon ✏️ **Edit**,
   coller les valeurs de l'étape 2, **Commit changes**.
2. Dans le dépôt : **Settings > Pages**. Source : **Deploy from a branch**, branche `main`, dossier
   `/ (root)`, **Save**.
3. Une à deux minutes plus tard, le site est en ligne à l'adresse :
   <https://maxpernlesang.github.io/LesRecettesdeLucie/>

## 7. Première ouverture (Max, une seule fois)

1. Ouvrir <https://maxpernlesang.github.io/LesRecettesdeLucie/> sur l'ordinateur, **Continuer avec Google**.
2. Le site indique que la base est vide : **Choisir recettes-initiales.json** et prendre le fichier
   reçu à part (dans Téléchargements). Les 247 fiches s'envoient en quelques secondes.

## 8. Pour Lucie

Ouvrir l'adresse du site sur son téléphone, toucher **Continuer avec Google**, choisir son compte.
C'est tout : le téléphone reste connecté, elle n'aura plus à le refaire. Ajouter la page aux favoris
pour la retrouver.

Bon à savoir : sur iPhone, Safari efface les données d'un site qu'on n'a pas ouvert depuis plus de
7 jours. Si elle ne s'en sert pas pendant plus d'une semaine, il faudra peut-être toucher une fois
**Continuer avec Google** (son compte est proposé directement, sans mot de passe).

---

## Si quelque chose ne marche pas

| Message | Que faire |
| --- | --- |
| « Le site n'est pas encore relié à Firebase » | `firebase-config.js` n'est pas rempli (étape 2). |
| « Cette adresse de site n'est pas autorisée… » | Ajouter `maxpernlesang.github.io` (étape 4). |
| « La connexion Google n'est pas activée… » | Étape 3. |
| « Le compte … n'a pas accès » | Adresse absente ou mal écrite dans les règles (étape 5). |
| La fenêtre Google ne s'ouvre pas | Autoriser les fenêtres pop-up pour le site, ou réessayer. |

## Fonctionnement

- `auth.js` : connexion Google (gardée sur l'appareil), lecture des recettes dans Firestore, import
  initial, puis lancement du site. Un compte non autorisé est refusé par les règles de Firestore,
  pas seulement par l'affichage.
- `app.js`, `style.css` : le site (recherche, dossiers, recalcul des grammages, ajout et modification).
- Base Firestore : `base/p01…` (fiches d'origine, par paquets de 40), `recettes/<id>` (fiches ajoutées
  ou modifiées), `site/dossiers`, `site/masquees`.
- L'écran **Sauvegarde** permet toujours d'exporter une copie de secours, et de se déconnecter.
- Si le réseau coupe pendant une modification, elle est gardée et part dès que la connexion revient.
