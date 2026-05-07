# Roadmap de uso del usuario consorcio (paso a paso)

Pensá esto como un guion para probar de punta a punta. Cada paso te dice **dónde**, **qué hacer** y **qué deberías ver**.

## Paso 0 — Setup previo (una sola vez)

⚠️ Si todavía no la aplicaste, **corré la migración de comprobantes** sino el flujo del vecino falla:

```
supabase db push
# o aplicá manualmente: supabase/migrations/20260506_payment_receipts.sql
```

Asegurate también de que el `.env` tenga `NEXT_PUBLIC_APP_BASE_URL=http://localhost:3000` para que los links que se mandan al vecino funcionen.

## Paso 1 — Entrar y elegir edificio

- Logueate como usuario `consorcio_admin`.
- Vas a caer en `/iadmin/cartera` (lista de edificios). **No hay sidebar acá** — es a propósito: tu primer paso es elegir con cuál trabajar.
- Click en una fila/edificio → entrás a `/iadmin/consorcios/{id}/resumen`.
- ✅ Aparece el sidebar del edificio (Resumen · Movimientos · Gastos · Liquidaciones · Cobranzas · Recordatorios · Configuración).

## Paso 2 — Configurar el edificio (primera vez)

Desde **Configuración** del edificio asegurate de tener:

1. **Unidades cargadas** con sus alícuotas que sumen 100%.
2. **Cuenta bancaria** con CBU + Alias (si no, los avisos al vecino salen sin datos para depositar).
3. **Titulares** de cada unidad (al menos uno con teléfono para que funcione el link wa.me).

✅ Si el Resumen muestra "Alícuotas: 100% ✓" y la cuenta aparece en el modal de Liquidar, este paso está OK.

## Paso 3 — Cargar los gastos del mes (Movimientos)

Andá a **Movimientos**.

**3a. Gastos fijos recurrentes** (luz, encargado, ascensor…):

- Botón **"Agregar"** en la sección Gastos fijos.
- Cargá el primero (Ej: "Luz" · 50000 · ordinaria) y guardá.
- Cargá un par más.
- ✅ Subtotal de la sección se actualiza.

**3b. Egresos eventuales** (limpieza salón, compra de bolsas…):

- Botón **"Agregar"** en la sección Egresos eventuales.
- Ej: "Limpieza salón" · 15000 · ordinaria.

**3c. Editar y borrar**:

- Click en el monto de cualquier línea → editás directo, perdés foco / Enter y guarda.
- Botón papelera → confirma y borra esa línea del mes.

**3d. Replicar mes anterior** (si hay datos del mes pasado):

- Botón **"Replicar mes anterior"** → copia todos los gastos fijos del mes pasado a este, en celdas vacías.
- ✅ Toast: "Se replicaron N gastos fijos".

## Paso 4 — Revisar el Resumen

Volvé a **Resumen**:

- ✅ KPIs: ingresos cobrados, gastos del mes (= lo que cargaste), saldo, % cobranza.
- ✅ Desglose Ord./Extra coincide con lo cargado.
- ✅ Tarjeta "Estado": alícuotas 100% · liquidación pendiente.

## Paso 5 — Liquidar y enviar a vecinos

- Click en el botón grande **"Liquidar y enviar"**.
- Modal de confirmación muestra: total a distribuir, cantidad de unidades, próximo vencimiento, CBU + Alias copiables (botón copiar funciona).
- Si falta algo (alícuotas mal, sin gastos, sin permiso, ya emitida) → te avisa en amarillo y deshabilita el botón.
- Click **"Confirmar y emitir"**:
  - ✅ Toast verde: "Liquidación emitida. N unidades."
  - ✅ Se abre el `PublishDialog` con la lista de vecinos.
  - Cada vecino con teléfono tiene un botón **WhatsApp** que abre `wa.me/...` con el mensaje precargado (incluye monto, vencimiento, CBU/alias y link de detalle).

## Paso 6 — Vista cruzada del edificio (sidebar Operaciones)

Probá los items del sidebar mientras estás en el edificio:

- **Gastos** → bandeja filtrada por este edificio. Aparece chip "Filtrado por edificio: X" con "Quitar filtro".
- **Liquidaciones** → la corrida que acabás de emitir aparece en la tabla.
- **Recordatorios** → si ya pasó algún vencimiento, podés generar avisos.
- **Cobranzas** → es un stub, dice "se desarrolla en fase 4". Sin acción real todavía.

✅ El sidebar del edificio se mantiene en todas estas pantallas (no salís del contexto).

## Paso 7 — Probar el otro lado: el vecino reporta el pago

Cerrá sesión, **logueate como un propietario** que sea titular de alguna unidad del edificio.

- Caés en `/propietario`.
- ✅ Vas a ver tu unidad con la liquidación recién emitida y "Pendiente: $X".
- Click en **"Reportar pago"**:
  - Cargá monto (precargado con el saldo), fecha, método (transferencia/MP/efectivo/otro), referencia y un comprobante (PNG/JPG/PDF).
  - **"Enviar comprobante"** → toast: "Comprobante enviado. El admin lo va a revisar."
- El receipt queda en `iadmin_payment_receipts` con status `pending`.

## Paso 8 — Trabajar con varios edificios

- Click en **"← Volver a Cartera"** del sidebar.
- ✅ Sidebar desaparece, ves todos los edificios.
- Pickeás otro → sidebar de ESE edificio. Cada uno mantiene sus gastos/liquidaciones independientes.

---

## Lo que **todavía no está hecho** (para que sepas)

1. **Pantalla del admin para revisar comprobantes**: el vecino sube comprobante pero no hay UI todavía para que el admin lo apruebe/rechace y eso impacte el saldo. Hoy sigue como `pending` en la base.
2. **Cobranzas reales**: la página es stub.
3. **Notificación al vecino logueado**: hoy el aviso solo va por wa.me. No hay bandeja de notificaciones in-app cuando llega una liquidación nueva.
4. **Fechas de vencimiento configurables**: hoy las maneja la liquidación con valores por defecto. Si querés controlar exactamente qué fecha sale en el aviso, hay que tocarlo en config.

## Atajos para testear rápido

- ¿Querés simular un consorcio nuevo? Pickeá uno sin gastos, vas a ver "Sin datos para mostrar" en Resumen — está bien, es la pantalla nueva tolerante a vacío.
- Si tenés un solo edificio y querés saltar Cartera, podés ir directo a `/iadmin/consorcios/{id}` que te redirige al Resumen.
