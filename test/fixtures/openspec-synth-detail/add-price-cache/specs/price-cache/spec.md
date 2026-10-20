# Spec Delta

## Purpose

Servir precios desde memoria mientras sigan vigentes.

## ADDED Requirements

### Requirement: Clave de caché por región y producto
El sistema SHALL guardar cada precio con la clave compuesta región y producto.

#### Scenario: Acierto de caché
- **WHEN** se pide un precio ya guardado y vigente
- **THEN** se devuelve sin llamar al servicio de tarifas

#### Scenario: Región distinta
- **WHEN** se pide el mismo producto en otra región
- **THEN** se trata como una clave distinta

### Requirement: Vigencia configurable
El sistema SHALL descartar las entradas con más antigüedad que el TTL.

#### Scenario: Entrada caducada
- **WHEN** una entrada supera el TTL
- **THEN** la siguiente consulta va al servicio de tarifas

### Requirement: Invalidación al publicar censo
El sistema SHALL vaciar las entradas afectadas al publicar un censo.

#### Scenario: Censo regional
- **WHEN** se publica un censo de una región
- **THEN** solo se vacían las entradas de esa región

#### Scenario: Censo global
- **WHEN** se publica un censo global
- **THEN** se vacía toda la caché

#### Scenario: Publicación repetida
- **WHEN** el mismo censo se publica dos veces
- **THEN** la segunda publicación no cambia nada
