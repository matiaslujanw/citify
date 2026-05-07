# Roadmap de testeo · Usuario consorcio + flujos relacionados

Esta guía está pensada como un guion para probar **toda la funcionalidad** del usuario consorcio de punta a punta — incluyendo los puntos donde se cruza con propietarios y vecinos. Cada paso te dice **dónde**, **qué hacer** y **qué deberías ver** (con su ✅).

> **Roles que vas a necesitar para un test completo**:
> - `consorcio_admin` (admin del edificio)
> - `propietario` (dueño de una unidad)
> - opcional: un `vecino_principal` distinto del propietario (para simular alquiler)
> - opcional: un segundo `consorcio_admin` o un `super_admin` para casos cross-admin

---

## Paso 0 — Setup previo (una sola vez)

Aplicá estas migraciones SQL en Supabase si todavía no las corriste, **en orden**:

| Archivo | Para qué |
|---|---|
| `20260424_iadmin_recurring_reminders.sql` | columnas `is_recurring/recurring_*` en providers + tabla recordatorios |
| `20260506_payment_receipts.sql` | tabla + bucket de comprobantes que sube el propietario |
| `20260507_fix_liquidation_runs_recursion.sql` | fix de RLS recursivo en `iadmin_liquidation_runs` |
| `20260508_user_notifications.sql` | tabla de notificaciones in-app (campanita) |

Verificá también:
- `.env` con `NEXT_PUBLIC_APP_BASE_URL=http://localhost:3000` (sino los links del wa.me salen rotos).
- En **Storage → Buckets** de Supabase deben aparecer: `iadmin-expense-documents` y `iadmin-payment-receipts`.

---

## Bloque A — Lado del admin del consorcio

### A.1 — Entrar y elegir edificio

- Logueate como `consorcio_admin`.
- Vas a caer en `/iadmin/cartera` (lista de edificios).
- ✅ **No hay sidebar** acá — full-width, primero elegís edificio.
- Click en una fila → entrás a `/iadmin/consorcios/{id}/resumen`.
- ✅ Aparece el sidebar del edificio (Volver a Cartera · Resumen · Movimientos · Gastos · Liquidaciones · Cobranzas · Comprobantes · Recordatorios · Configuración).

### A.2 — Configurar el edificio (primera vez)

Desde **Configuración** asegurate de tener:

1. **Unidades cargadas con alícuotas que sumen 100%** → Configuración → "Datos del consorcio".
2. **Cuenta bancaria con CBU + Alias** → Configuración → "Cuentas bancarias" (o desde el modal de Liquidar, link "Editar cuentas").
3. **Titulares vinculados** a cada unidad (`unit_profile_memberships`). Para testear bien:
   - Al menos una unidad con un **propietario** registrado (con teléfono y email).
   - Para probar caso de alquiler: una unidad con **propietario + vecino_principal distintos**.

✅ Si el Resumen muestra "Alícuotas: 100% ✓" y la cuenta aparece en el modal de Liquidar, este paso está OK.

### A.3 — Cargar los gastos del mes (Movimientos)

Sidebar → **Movimientos**.

**3a. Gastos fijos recurrentes** (luz, encargado, ascensor…):
- Botón **"Agregar"** en la sección "Gastos fijos".
- Cargá uno (Ej: "Luz" · `$50.000` · ordinaria) y guardá.
- ✅ El monto se muestra con separador de miles (`$ 50.000`), subtotal de la sección actualizado.

**3b. Egresos eventuales** (limpieza salón, compras puntuales…):
- Botón **"Agregar"** en la sección "Egresos eventuales".
- Ej: "Limpieza salón" · `$15.000` · ordinaria.

**3c. Editar y borrar**:
- Click en el botón **lápiz** de cualquier línea → modo edición con input + botón ✓ verde / ✗.
- ✅ Enter guarda, Escape cancela.
- Botón **papelera** → confirma y borra esa línea del mes.

**3d. Replicar mes anterior** (si hay datos del mes pasado):
- Botón **"Replicar mes anterior"** → copia todos los gastos fijos del mes pasado a este, en celdas vacías.
- ✅ Toast: "Se replicaron N gastos fijos".

### A.4 — Revisar el Resumen

Sidebar → **Resumen**:

- ✅ KPIs: ingresos cobrados, gastos del mes, saldo, % cobranza.
- ✅ Desglose Ord./Extra coincide con lo cargado.
- ✅ Tarjeta "Estado": alícuotas 100% ✓ · liquidación pendiente.

### A.5 — Liquidar y enviar a vecinos

Click en el botón grande **"Liquidar y enviar"** del header del Resumen.

Modal de confirmación:
- ✅ Total a distribuir, cantidad de unidades, próximo vencimiento, desglose ord./extra.
- ✅ Tarjeta "Cuenta para depositar" con CBU + Alias **copiables** (botón copiar funciona). Si falta, link directo a `/cuentas`.
- ✅ **Editor de vencimientos**:
  - Mínimo 1 vencimiento, máximo 4.
  - Cada uno con etiqueta + fecha + recargo %.
  - Mostrá el "ejemplo por unidad" debajo (ej: "una unidad de $650.000 paga $682.500 (+$32.500)").
  - Botón "+ Agregar" para agregar otro vencimiento; botón papelera para quitar.
  - Texto explicativo: "el recargo se aplica por unidad, no sobre el total".
- ✅ Campo **"Nota para los vecinos (opcional)"** — máximo 280 caracteres. Se concatena al final del mensaje.
- ✅ Bloqueos visibles si falta algo (alícuotas mal, sin gastos, sin permiso, ya emitida).

Click **"Confirmar y emitir"**:
- ✅ Toast verde: "Liquidación emitida. N unidades."
- ✅ Se abre el `PublishDialog` con la lista de todos los vecinos. Cada uno con botón verde de **WhatsApp** que abre `wa.me/...` con el mensaje precargado (incluye monto, **todos los vencimientos** con recargo, CBU/alias, link de detalle, y la nota si la pusiste).
- ✅ La prioridad del contacto del WhatsApp es: **vecino_principal** → propietario → holder cargado a mano.
- ✅ Se disparan **notificaciones in-app** a cada propietario y vecino_principal de cada unidad (deduplicadas si son el mismo profile).

### A.6 — Sidebar del edificio · Operaciones

Probá los items del sidebar mientras estás en el edificio:

- **Gastos** → bandeja filtrada por este edificio (`?propertyId=`). Chip "Filtrado por edificio: X" con "Quitar filtro".
- **Liquidaciones** → la corrida que acabás de emitir aparece en la tabla (estado: Emitida).
- **Cobranzas** → ✅ Vista nueva con estado del último mes emitido:
  - 5 KPIs arriba: Cobrado · Pendiente · En tiempo · Tarde · Sin pagar/parcial.
  - Pills clickeables para filtrar por estado.
  - Buscador por unidad o titular.
  - Lista por unidad con badge de estado, total, cobrado, debe, último pago.
  - Botón **"Recordar"** verde por unidad con saldo pendiente → wa.me con mensaje precargado.
  - Click en chevron → expande detalle (ord/extra/saldo previo + lista de pagos registrados).
- **Comprobantes** → bandeja con tabs **Pendientes / Aprobados / Rechazados / Todos**. Por ahora vacía si nadie reportó pago todavía.
- **Recordatorios** → si ya pasó algún vencimiento, podés generar avisos.

✅ El sidebar del edificio se mantiene en todas estas pantallas (no salís del contexto del edificio).

### A.7 — Trabajar con varios edificios

- Click en **"← Volver a Cartera"** del sidebar.
- ✅ Sidebar desaparece, ves todos los edificios.
- Pickeás otro → sidebar de ESE edificio. Cada uno mantiene sus gastos/liquidaciones independientes.

---

## Bloque B — Lado del propietario / vecino_principal

### B.1 — Entrar y ver la liquidación nueva

Cerrá sesión, **logueate como propietario** vinculado a alguna unidad del edificio que liquidaste.

- Caés en `/propietario`.
- ✅ Ves tu unidad con la liquidación recién emitida y "Pendiente: $X".
- ✅ Campanita en el navbar con badge rojo (1 o más).
- Click en la campanita → dropdown muestra "Nueva liquidación de mayo · Tu unidad 4B de Edificio Belgrano: $52.300 con vencimiento el 10/06/2026."
- Click en la notificación → te lleva a `/propietario` y la marca como leída (badge baja).

### B.2 — Bandeja completa de notificaciones

Click en "Ver todas" del dropdown → vas a `/notificaciones`:

- ✅ Lista completa con tabs "Todas / No leídas".
- ✅ Cada notificación tiene tipo (badge "Nueva liquidación", etc.), título, body y fecha legible ("hace 2 min").
- ✅ Botón **"Marcar todas como leídas"** funciona.

### B.3 — Reportar el pago — caso "en término"

Volvé a `/propietario` (o desde el dropdown). Click en **"Reportar pago"** de una unidad con saldo.

- ✅ Banner verde arriba: **"Pagás dentro del primer vencimiento"** con la fecha y el monto sin recargo.
- ✅ Monto **precargado con el subtotal sin recargo**.
- Cargá fecha (default: hoy), método (transferencia/MP/efectivo/otro), referencia opcional, y opcionalmente **un comprobante** (PNG/JPG/PDF, máx 10MB).
- **"Enviar comprobante"** → toast: "Comprobante enviado. El admin lo va a revisar."
- El receipt queda en `iadmin_payment_receipts` con status `pending`.

### B.4 — Reportar el pago — caso "tarde con recargo"

Para probar este caso, tenés 2 opciones:
- En el modal de Liquidar, poné el 1er vencimiento con una fecha **anterior a hoy** y el 2do con una fecha futura.
- O usá una liquidación vieja cuyo 1er venc ya pasó.

Reportá un pago de esa unidad:
- ✅ Banner **ámbar**: "Estás pagando con +X% de recargo. Pasaste el primer vencimiento. Próximo: dd/mm/yyyy. Total a pagar: $X (recargo: $Y)."
- ✅ Monto precargado con el subtotal **+ recargo aplicado**.

### B.5 — Reportar el pago — caso "todos los vencimientos pasados"

Si todos los vencimientos pasaron:
- ✅ Banner **rojo**: "Pasaste todos los vencimientos. El monto sugerido incluye el recargo del último vencimiento (dd/mm/yyyy · +X%): $X."

---

## Bloque C — El admin aprueba/rechaza el comprobante

Volvé al admin (`consorcio_admin`).

### C.1 — Ver los comprobantes pendientes

- Sidebar del edificio → **Comprobantes**.
- ✅ Tab "Pendientes" muestra el comprobante recién enviado: unidad, vecino, monto, método, fecha, referencia, badge "Pendiente".
- Click en **"Ver"** → preview modal del archivo (imagen o PDF) con link a abrir en nueva pestaña.

### C.2 — Aprobar

Click en **"Aprobar"** → modal de confirmación:
- Opcionalmente cargá una nota interna.
- Click "Confirmar".
- ✅ Toast: "Comprobante aprobado. Pago registrado."
- ✅ El receipt cambia a `approved` (badge verde).
- ✅ Se crea automáticamente un `iadmin_payments` real (con monto, método, referencia, etc.).
- ✅ El propietario recibe **notificación in-app**: "Tu pago fue aprobado · El admin aprobó tu comprobante por $50.000 de la unidad 4B (05/2026)."

Volvé a `/iadmin/cobranzas?propertyId=…` (Cobranzas del edificio):
- ✅ La unidad pasó al bucket "Pagó en tiempo" o "Pagó tarde con recargo" según la fecha.
- ✅ Saldo de esa unidad bajó.
- ✅ Stats arriba reflejan el cambio.

### C.3 — Rechazar

Pedile al propietario que reporte otro pago. En la bandeja:
- Click en **"Rechazar"** (botón con ícono X rojo).
- Modal: poné una nota explicando por qué (recomendado).
- ✅ Toast: "Comprobante rechazado."
- ✅ El receipt cambia a `rejected` con la nota.
- ✅ El propietario recibe notificación: "Tu pago fue rechazado · El admin rechazó tu comprobante de la unidad 4B (05/2026). Motivo: …"

El propietario puede volver a reportar — se crea otro receipt con status `pending` (los anteriores quedan en su historial).

---

## Bloque D — Casos especiales y border cases

### D.1 — Edificio nuevo sin gastos

- Cargás un nuevo edificio sin nada cargado.
- En **Resumen**, ✅ debería ver "Sin datos para mostrar" (placeholder amigable, no un 404).
- En **Movimientos**, idem — vacío con botón "Agregar".

### D.2 — Liquidación con propietario que no vive ahí (alquiler)

- Cargá una unidad con `propietario` distinto del `vecino_principal`.
- Liquidá.
- ✅ El **vecino_principal recibe notificación in-app**.
- ✅ El **propietario también recibe notificación in-app**.
- ✅ El **wa.me apunta al vecino_principal** (no al propietario).
- ✅ Tanto el propietario como el vecino pueden entrar a `/propietario` (si tienen el rol correcto) y ver la liquidación.

### D.3 — Unidad sin titulares cargados en Citify

- Si una unidad solo tiene un `holder` cargado a mano (sin profile vinculado):
- ✅ El wa.me usa el contacto del holder.
- ✅ No se dispara notificación in-app para esa unidad (no hay profile).

### D.4 — Sin CBU/alias cargados

- Liquidás sin cuenta bancaria con CBU/alias.
- ✅ El modal te muestra el cartel ámbar con link a "Cuentas".
- Si emitís igual, el mensaje sale **sin la línea bancaria** (no rompe).

### D.5 — Re-emitir la liquidación del mismo mes

- Después de emitir, si volvés a abrir el modal:
- ✅ Bloqueado con mensaje "La liquidación de este mes ya fue emitida".
- Si la liquidación se cierra (status `closed`) → idem.

### D.6 — Doble propietario en una unidad

- Cargá 2 propietarios activos en una unidad (caso copropiedad).
- ✅ Ambos reciben notificación in-app.
- El que esté marcado `is_primary` es el que aparece en el contacto del wa.me.

---

## Lo que **todavía no está hecho** (para que sepas)

1. **Cobranzas cross-edificio** → la vista de cobranzas hoy es por edificio (con `?propertyId=`). Para una vista global cross-cartera todavía falta.
2. **Reconciliación bancaria** → subir extracto y matchear pagos: pendiente.
3. **Bitácora de envío de WhatsApp** → hoy no se registra a quién ya le mandaste el mensaje.
4. **"Mandar a todos" automático** → tenés que clickear vecino por vecino en el `PublishDialog`.
5. **Reabrir el panel de envío** de una liquidación pasada → si cerraste sin mandar a todos, no podés reabrirlo.
6. **Pantalla "Edificio"** unificada → datos del edificio + ocupación + lista clara de vecinos. Hoy está disperso entre Configuración → "Datos del consorcio" y Configuración → "Reportes".

---

## Atajos para testear rápido

- ¿Querés simular un consorcio nuevo? Pickeá uno sin gastos, vas a ver "Sin datos para mostrar" en Resumen.
- Si tenés un solo edificio y querés saltar Cartera, podés ir directo a `/iadmin/consorcios/{id}` que te redirige al Resumen.
- Para forzar una notificación de "Pago aprobado" rápido: como propietario subí un comprobante, como admin aprobalo, volvés a la cuenta del propietario y ya tenés la notificación.
- Para forzar un caso de "+5% recargo": en el modal de Liquidar, poné el 1er vencimiento con fecha de **ayer** (ya vencido) y el 2do con +30 días + recargo.
- Si la campanita no actualiza en 60s, refrescá el navegador (el polling solo corre cuando la pestaña está visible).

---

## Checklist rápido (TL;DR)

Marcá lo que ya verificaste:

**Admin del consorcio**:
- [ ] Cartera muestra mis edificios sin sidebar
- [ ] Al entrar a un edificio aparece el sidebar contextual
- [ ] Cargar gasto fijo + replicar mes anterior funciona
- [ ] Movimientos muestra montos en formato pesos `$X.XXX`
- [ ] Resumen muestra KPIs correctos
- [ ] Modal de Liquidar permite editar vencimientos y % recargo
- [ ] Modal de Liquidar muestra ejemplo por unidad y aclara que el recargo es individual
- [ ] Confirmar emisión genera la liquidación + abre PublishDialog con wa.me
- [ ] Sidebar Cobranzas muestra estado del mes con buckets
- [ ] Sidebar Comprobantes muestra los reportes del propietario
- [ ] Aprobar comprobante crea iadmin_payments y baja saldo
- [ ] Rechazar comprobante deja motivo visible

**Propietario / vecino**:
- [ ] Recibe notificación in-app al emitirse la liquidación
- [ ] Campanita en navbar muestra contador
- [ ] Bandeja `/notificaciones` lista todas
- [ ] Reportar pago en término → banner verde, monto sin recargo
- [ ] Reportar pago tarde → banner ámbar, monto con recargo
- [ ] Recibe notificación al ser aprobado/rechazado
- [ ] Comprobante con archivo se ve correctamente en preview del admin

**Casos múltiples usuarios**:
- [ ] Propietario que no vive ahí + vecino_principal → ambos reciben notif y wa.me va al vecino
- [ ] Doble propietario → ambos reciben notif
- [ ] Holder a mano sin profile → solo wa.me, sin notif in-app
