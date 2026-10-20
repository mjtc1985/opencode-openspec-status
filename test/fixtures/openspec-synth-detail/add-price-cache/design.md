# Design

## Context

El módulo de precios llama al servicio de tarifas en cada petición.

## Goals / Non-Goals

**Goals:**
- Reducir las llamadas al servicio de tarifas.

**Non-Goals:**
- Caché distribuida entre instancias.

## Decisions

### 1. Caché en memoria por instancia
- **Decisión**: un mapa con expulsión LRU dentro del proceso.
- **Razón**: no añade infraestructura.

### 2. Clave compuesta región y producto
- **Decisión**: la clave es `region:producto`.

### 3. Invalidación por evento de censo
- **Decisión**: escuchar el evento de publicación y vaciar por región.

## Risks / Trade-offs

- **[Precios desfasados entre instancias]** → cada instancia tiene su caché.
  *Mitigación*: TTL corto por defecto.
- **[Consumo de memoria]** → muchas regiones por muchos productos.
  *Mitigación*: límite de entradas con LRU.

## Migration Plan

1. Desplegar con la caché desactivada.
2. Activarla por entorno.
