# Plano de la casa (dashboard `/map`)

## Objetivo

Un plano de la casa en el panel domótico con las luces y los sensores de cada estancia.

## Problema / por qué

El panel actual es una lista y cuesta encontrar cada dispositivo.

## Alcance autorizado

- Plano en SVG, panel versionado en el repo y tarjetas del aspirador.

## Restricciones

- No tocar la configuración que no sea del plano.

## TDD

Off (fuente: sin configuración del proyecto). Runner: ninguno.

## Tareas
- [x] T1 Plano rectilíneo `www/floorplan/plano.svg` + `plano.css`, generado por `floorplan/generate_plan.py`. Ruta: inline (fichero de diseño ya en contexto). Commits `e23df9c`, `8907405`.
- [x] T2 Configuración del panel versionada en `dashboards/map.json`. Commit `0ceebd4`.
- [x] T3 Tarjetas de terceros instaladas y el servidor reiniciado.
- [x] T4 SVG y CSS copiados a `config/www/floorplan/` y panel guardado (la lectura de vuelta coincide con `map.json`).
- [x] T5 Selecciones predefinidas con las 9 habitaciones del aspirador.
- [x] T6 Limpieza: ficheros viejos archivados en `backups/plano-antiguo/`.
- [x] T7 `README.md` y `CHANGELOG.md`.

## Criterios de aceptación

- El plano se ve en el móvil y cada estancia responde al tocarla.

## Progreso

- T1–T7: ✅ hechas.

## Siguiente paso

El usuario comprueba `/map/plano` en el móvil y decide si añade más estancias.
