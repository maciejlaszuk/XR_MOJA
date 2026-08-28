/*
  MOJA XR v14 — konfiguracja współpracy.

  1. Załóż projekt w Supabase.
  2. Kliknij Project Connect albo wejdź w Settings > API Keys i skopiuj:
       - Project URL
       - Publishable key (w starszym projekcie: legacy anon public key)
  3. Wklej je poniżej.
  4. Ustaw enabled: true.

  UWAGA:
  - Klucz publishable / legacy anon jest przeznaczony do kodu przeglądarki i nie jest
    sekretem administracyjnym.
  - NIGDY nie wklejaj tutaj secret key ani service_role key.
*/
window.MOJA_XR_CONFIG = {
  version: "14",

  collaboration: {
    enabled: false,

    supabaseUrl: "https://TWOJ-PROJEKT.supabase.co",
    supabasePublishableKey: "WKLEJ_TUTAJ_PUBLISHABLE_LUB_ANON_KEY",

    // Publiczne kanały są najprostsze do uruchomienia bez logowania Supabase.
    // Dostęp do samych modeli ograniczysz później przez Cloudflare Access.
    publicChannels: true,

    // 10 Hz wystarcza dla głowy, dłoni i lasera przy dwóch osobach.
    poseHz: 10,

    // Pusty = współpraca uruchamia się tylko dla linku zawierającego ?room=...
    defaultRoom: ""
  }
};
