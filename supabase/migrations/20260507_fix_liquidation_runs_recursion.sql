-- Fix: la política "iadmin_liquidation_runs owner select" hacía un EXISTS
-- contra `iadmin_liquidation_items`, cuya propia política a su vez lee
-- `iadmin_liquidation_runs`. Eso causa "infinite recursion detected in
-- policy" cuando se inserta o lee un run.
--
-- Reescribimos la política para resolver la propiedad por
-- `managed_property_id` + membresía del propietario, sin pasar por
-- liquidation_items.

drop policy if exists "iadmin_liquidation_runs owner select" on public.iadmin_liquidation_runs;
create policy "iadmin_liquidation_runs owner select"
on public.iadmin_liquidation_runs for select
to authenticated
using (
  exists (
    select 1
    from public.iadmin_units u
    join public.unit_profile_memberships m on m.unit_id = u.id
    where u.managed_property_id = public.iadmin_liquidation_runs.managed_property_id
      and m.profile_id = auth.uid()
      and m.relationship_type = 'propietario'
      and m.active
  )
);
