-- Keep public.profiles.email in sync with auth.users.email after a
-- Supabase Auth email change is confirmed. handle_new_user() only ever
-- fired on INSERT, so the "Your profile" email-change flow (which relies
-- on Auth's double-confirmation and never writes profiles.email itself)
-- silently never took effect: the profile kept showing the old address
-- forever even after both confirmation links were clicked.

CREATE OR REPLACE FUNCTION public.handle_user_email_update()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE public.profiles
  SET email = NEW.email,
      updated_at = NOW()
  WHERE user_id = NEW.id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS on_auth_user_email_updated ON auth.users;

CREATE TRIGGER on_auth_user_email_updated
  AFTER UPDATE OF email ON auth.users
  FOR EACH ROW
  WHEN (OLD.email IS DISTINCT FROM NEW.email)
  EXECUTE FUNCTION public.handle_user_email_update();
