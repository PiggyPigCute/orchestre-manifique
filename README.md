# Site de l'Orchestre Manif'ique 

Deux projets pour **orchestre-manifique.chruk.fr** :
* `site/`, `orchestre-manifique.chruk.fr`, site statique de présentation, avec la frise des sorties (photos tirées au hasard du drive)
* `photos/`, `/photos/`, Drive photo public (Node/Express, port **3010**). Tout le monde peut déposer des photos, les admins suppriment et gèrent les dates

Le site statique lit le drive via `/photos/api/events` et `/photos/api/photos` : les deux doivent être sur le même domaine (voir `nginx.conf.example`).

## Mise en route du drive

```sh
cd photos
npm install --omit=dev
node scripts/hash-password.js "le-mot-de-passe-admin"
# colle la sortie dans data/admin-password.json :  { "hash": "sel:hash" }
PORT=3010 pm2 start server.js --name orma-photos
```

`./reload.sh` pour mettre à jour.

- Tant que `data/admin-password.json` a `"hash": null`, personne ne peut se connecter en admin.
- Changer le hash déconnecte toutes les sessions admin, sans redémarrer.
- Connexion admin : bouton « Admin » en haut de `/photos/`. Une fois connecté·e, on peut ajouter, modifier ou supprimer les dates, et supprimer des photos (une par une ou par sélection).
- Il faut créer au moins une date avant que le public puisse déposer des photos.

## Données

- `photos/data/events.json` : `[{ id, date: "YYYY-MM-DD", title }]`
- `photos/data/photos.json` : `[{ id, eventId, credit, file, thumb, width, height, uploadedAt }]`
- `photos/uploads/originals/` : fichiers d'origine ; `photos/uploads/thumbs/` : vignettes JPEG (1000 px max, générées par le navigateur à l'envoi)

Pour sauvegarder, il suffit de copier `photos/data/` et `photos/uploads/`.
