# Dibuja la frase

Dinámica de grupo: el facilitador pone una frase, cada participante la dibuja desde su dispositivo y, cuando el facilitador lo decide, todos los dibujos se muestran a la vez.

- Sin cuentas: los participantes entran con un enlace (o un código de 4 letras) y su nombre.
- Los dibujos de los demás no se envían a los navegadores hasta que el facilitador pulsa «Revelar dibujos».
- Sin dependencias: solo Node 18 o superior.

## Probar en tu ordenador

```
node server.js
```

Abre http://localhost:3000, pulsa «Crear sesión» y, en otra pestaña, entra con el enlace de participantes.

## Publicarla en internet (Render, gratis)

1. Sube esta carpeta a un repositorio nuevo de GitHub.
2. En https://render.com crea un **Web Service** conectado a ese repositorio.
3. Runtime: **Node**. Build command: vacío (o `echo ok`). Start command: `node server.js`. Plan: Free.
4. Cuando termine, Render te da una dirección tipo `https://dibuja-la-frase.onrender.com`. Esa es tu página.

Sirve igual en Railway, Fly.io o cualquier servidor con Node. Si quieres tu propio dominio, se añade desde el panel del servicio.

## Cosas a tener en cuenta

- Las sesiones viven en la memoria del servidor. Si el servidor se reinicia, se pierden. En el plan gratuito de Render el servicio se duerme tras unos minutos sin visitas y tarda cerca de un minuto en despertar: ábrelo unos minutos antes de empezar.
- Una sesión admite hasta 80 participantes y se borra tras 12 horas sin actividad.
- El enlace de facilitador (con `#k=...`) da el control de la sesión. No lo compartas.
