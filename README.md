# Fracas

Petit jeu de ville dans un onglet de navigateur : une voiture, des caisses, des cônes, et une vraie physique (chaque caisse part en planches). Codé par une IA (Claude) pour une vidéo de la chaîne Nogaruki.

**Jouer :** https://fracas.vercel.app (clavier, sur ordinateur)

## Commandes
- W ou flèche haut : avancer
- A / D : tourner
- S : freiner, Espace : frein à main
- R : tout remettre en place

## Lancer en local
Modules ES sans build : `python -m http.server 8765` dans ce dossier, puis http://localhost:8765 (le double clic sur `index.html` ne marche pas).

## Technique
- [three.js](https://threejs.org) 0.187.0 (MIT, `lib/LICENSE-three`)
- [Rapier](https://rapier.rs) 0.21.0 (Apache 2.0, `lib/LICENSE-rapier`)

## English
A tiny city smash game running in a browser tab, coded by an AI (Claude) for a Nogaruki short. Keyboard only: W/arrow up to drive, A/D to steer, S to brake, Space for handbrake, R to reset.

Code du jeu : licence MIT (`LICENSE`).
