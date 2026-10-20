# Spec Delta

## MODIFIED Requirements

### Requirement: Consulta de precio
El endpoint de precios SHALL consultar la caché antes que el servicio de tarifas.

#### Scenario: Precio en caché
- **WHEN** el precio está en caché
- **THEN** responde con él y la cabecera `X-Cache: hit`

## REMOVED Requirements

### Requirement: Consulta directa al servicio de tarifas
Se sustituye por la consulta a través de la caché.

## RENAMED Requirements

- FROM: `### Requirement: Precio por producto`
- TO: `### Requirement: Precio por región y producto`
