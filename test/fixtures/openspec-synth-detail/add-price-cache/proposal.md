# Proposal

## Why

Cada consulta de precio llama al servicio de tarifas, que responde en cientos de
milisegundos y limita las peticiones por minuto. En picos de tráfico el listado
de productos se degrada.

Una caché por región y producto evita repetir la misma consulta dentro de su
vigencia.

## What Changes

- Caché en memoria de precios con clave por región y producto.
- **TTL configurable** por entorno (`PRICE_CACHE_TTL`), con valor por defecto
  de cinco minutos.
- Invalidación al publicar un censo nuevo de tarifas:
  - por región afectada;
  - completa si el censo es global.
- Métricas de aciertos y fallos de caché.
- El cliente de tarifas pasa a reintentar con espera exponencial.
- Documentación operativa del parámetro nuevo.
- Límite de memoria con expulsión LRU.

## Capabilities

### New Capabilities
- `price-cache`: caché de precios por región y producto con TTL e invalidación.

### Modified Capabilities
- `pricing-api`: el endpoint de precios lee de la caché antes que del servicio.

## Impact

- **Código**: módulo de precios y cliente de tarifas.
- **Configuración**: variable `PRICE_CACHE_TTL`.
