# Tasks

## 1. Caché

- [x] 1.1 Clave por región y producto
- [x] 1.2 TTL configurable
- [x] 1.3 Límite de memoria con expulsión LRU
- [x] 1.4 Métricas de aciertos y fallos

## 2. Integración

- [x] 2.1 Leer precios a través de la caché en el endpoint
- [x] 2.2 Envolver el cliente de tarifas con reintentos
      y espera exponencial
- [ ] 2.3 Cachear precios por región
- [ ] 2.4 Invalidar al publicar censo
- [ ] 2.5 Cabecera `X-Cache` en las respuestas

## 3. Pruebas

- [ ] 3.1 Acierto y fallo de caché
- [ ] 3.2 Caducidad por TTL
- [ ] 3.3 Invalidación regional y global
- [ ] 3.4 Carga con límite de memoria

## 4. Documentación

- [ ] 4.1 Parámetro `PRICE_CACHE_TTL`
- [ ] 4.2 Métricas nuevas
- [ ] 4.3 Nota de despliegue
