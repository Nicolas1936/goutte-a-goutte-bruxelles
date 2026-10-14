# Goutte à goutte — Bruxelles

Carte mobile-first des fontaines et bornes d’eau potable à Bruxelles. Elle affiche les adresses officielles disponibles, les points d’eau des gares SNCB et complète la carte avec OpenStreetMap.

## Sources

- [Fontaines de la Ville de Bruxelles](https://opendata.brussels.be/explore/assets/fontaines-d-eau-potable-gerees-par-la-ville-de-bruxelles/view/?flg=fr-fr) — bornes municipales, indiquées comme opérationnelles d’avril à septembre.
- [Bornes régionales Vivaqua](https://opendata.bruxelles.be/explore/assets/bornes-d-eau-potable-gerees-par-la-region-drinkwatertappunten-beheerd-door-het-gewest-vivaqua/view/?flg=fr-fr) — bornes actives renseignées par Vivaqua.
- [Bornes d’eau potable SNCB](https://opendata.brussels.be/explore/assets/bornes-eau-potable-gratuite-des-gares-sncb-gratis-drinkwatertappunten-van-nmbs-stations/view/?flg=fr-fr).
- [OpenStreetMap](https://www.openstreetmap.org/) via Overpass — complément régional selon la zone cartographique visible.

Les jeux de données officiels ont des périmètres différents et les données OSM peuvent être incomplètes. Vérifier les horaires et la signalétique sur place.

## Développement

```sh
npm ci
npm run dev
```

Contrôles avant publication :

```sh
npm run lint
npm run build
```

## Publication

Les changements poussés sur `main` déclenchent le workflow GitHub Pages. Le site est publié sur `https://nicolas1936.github.io/goutte-a-goutte-bruxelles/`.
