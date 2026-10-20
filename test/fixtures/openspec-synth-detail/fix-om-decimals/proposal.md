# Propuesta

## Por qué

Las cantidades de la orden de montaje pierden decimales al convertir unidades.
Hay pedidos de ejemplo como el de calle-real-34 y la referencia OM-2291 del
almacén que muestran el redondeo.

## Qué cambia

- Conversión de unidades con aritmética decimal.
- Redondeo solo al presentar, nunca al guardar.

## Capacidades

### Capacidades nuevas
Ninguna.

### Capacidades modificadas
- `order-units`: conversión decimal de cantidades.
