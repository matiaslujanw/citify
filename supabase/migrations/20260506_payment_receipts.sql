-- ============================================================================
-- Comprobantes de pago auto-reportados por propietarios
-- ----------------------------------------------------------------------------
-- Permite que el propietario logueado marque "ya pagué" sobre un
-- liquidation_item, indique monto/fecha/método y suba el comprobante.
-- El admin del consorcio luego revisa y aprueba/rechaza.
-- ============================================================================

create table if not exists public.iadmin_payment_receipts (
  id uuid primary key default gen_random_uuid(),
  liquidation_item_id uuid not null
    references public.iadmin_liquidation_items(id) on delete cascade,
  submitted_by_profile_id uuid not null
    references public.profiles(id) on delete cascade,
  amount numeric(14,2) not null check (amount > 0),
  paid_at date not null,
  method text,
  reference text,
  receipt_path text,
  notes text,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected')),
  reviewed_by_profile_id uuid references public.profiles(id) on delete set null,
  reviewed_at timestamptz,
  review_notes text,
  payment_id uuid references public.iadmin_payments(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz
);

create index if not exists iadmin_payment_receipts_item_idx
  on public.iadmin_payment_receipts(liquidation_item_id);

create index if not exists iadmin_payment_receipts_submitter_idx
  on public.iadmin_payment_receipts(submitted_by_profile_id);

create index if not exists iadmin_payment_receipts_status_idx
  on public.iadmin_payment_receipts(status)
  where status = 'pending';

alter table public.iadmin_payment_receipts enable row level security;

-- El propietario puede ver y crear comprobantes de los items de unidades
-- donde es propietario activo.
drop policy if exists "owner view receipts" on public.iadmin_payment_receipts;
create policy "owner view receipts" on public.iadmin_payment_receipts
  for select to authenticated
  using (
    submitted_by_profile_id = auth.uid()
    or exists (
      select 1
      from public.iadmin_liquidation_items li
      join public.iadmin_units u on u.id = li.unit_id
      join public.unit_profile_memberships m
        on m.unit_id = u.id
       and m.profile_id = auth.uid()
       and m.relationship_type = 'propietario'
       and m.active = true
      where li.id = liquidation_item_id
    )
  );

drop policy if exists "owner insert receipts" on public.iadmin_payment_receipts;
create policy "owner insert receipts" on public.iadmin_payment_receipts
  for insert to authenticated
  with check (
    submitted_by_profile_id = auth.uid()
    and exists (
      select 1
      from public.iadmin_liquidation_items li
      join public.iadmin_units u on u.id = li.unit_id
      join public.unit_profile_memberships m
        on m.unit_id = u.id
       and m.profile_id = auth.uid()
       and m.relationship_type = 'propietario'
       and m.active = true
      where li.id = liquidation_item_id
    )
  );

-- El admin del consorcio (miembro de la administración) puede ver y revisar.
drop policy if exists "admin view receipts" on public.iadmin_payment_receipts;
create policy "admin view receipts" on public.iadmin_payment_receipts
  for select to authenticated
  using (
    exists (
      select 1
      from public.iadmin_liquidation_items li
      join public.iadmin_liquidation_runs lr on lr.id = li.liquidation_run_id
      where li.id = liquidation_item_id
        and public.iadmin_user_belongs_to(lr.administration_id)
    )
  );

drop policy if exists "admin update receipts" on public.iadmin_payment_receipts;
create policy "admin update receipts" on public.iadmin_payment_receipts
  for update to authenticated
  using (
    exists (
      select 1
      from public.iadmin_liquidation_items li
      join public.iadmin_liquidation_runs lr on lr.id = li.liquidation_run_id
      where li.id = liquidation_item_id
        and public.iadmin_user_belongs_to(lr.administration_id)
    )
  )
  with check (
    exists (
      select 1
      from public.iadmin_liquidation_items li
      join public.iadmin_liquidation_runs lr on lr.id = li.liquidation_run_id
      where li.id = liquidation_item_id
        and public.iadmin_user_belongs_to(lr.administration_id)
    )
  );

-- ============================================================================
-- Storage bucket para comprobantes de pago
-- ============================================================================
insert into storage.buckets (id, name, public)
values ('iadmin-payment-receipts', 'iadmin-payment-receipts', false)
on conflict (id) do nothing;

-- Path convention: {liquidation_item_id}/{random}-{filename}
-- El primer segmento del path identifica el liquidation_item.

drop policy if exists "payment receipts read" on storage.objects;
create policy "payment receipts read" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'iadmin-payment-receipts'
    and (
      -- Propietario activo de la unidad asociada al item
      exists (
        select 1
        from public.iadmin_liquidation_items li
        join public.iadmin_units u on u.id = li.unit_id
        join public.unit_profile_memberships m
          on m.unit_id = u.id
         and m.profile_id = auth.uid()
         and m.relationship_type = 'propietario'
         and m.active = true
        where li.id::text = (storage.foldername(name))[1]
      )
      or
      -- Admin del consorcio
      exists (
        select 1
        from public.iadmin_liquidation_items li
        join public.iadmin_liquidation_runs lr on lr.id = li.liquidation_run_id
        where li.id::text = (storage.foldername(name))[1]
          and public.iadmin_user_belongs_to(lr.administration_id)
      )
    )
  );

drop policy if exists "payment receipts upload" on storage.objects;
create policy "payment receipts upload" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'iadmin-payment-receipts'
    and exists (
      select 1
      from public.iadmin_liquidation_items li
      join public.iadmin_units u on u.id = li.unit_id
      join public.unit_profile_memberships m
        on m.unit_id = u.id
       and m.profile_id = auth.uid()
       and m.relationship_type = 'propietario'
       and m.active = true
      where li.id::text = (storage.foldername(name))[1]
    )
  );

-- updated_at trigger
create or replace function public.iadmin_payment_receipts_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_updated_at on public.iadmin_payment_receipts;
create trigger set_updated_at
  before update on public.iadmin_payment_receipts
  for each row
  execute function public.iadmin_payment_receipts_set_updated_at();
