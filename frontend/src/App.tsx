import { useEffect, useState, type ReactNode } from 'react';

import { authStore, useAuth } from './store/auth.store';
import { useChatStore, selectTotalUnread } from './store/chat.store';
import { usePreferences, applyTheme } from './store/preferences.store';
import { realtimeClient } from './realtime/socket';
import { clearAllDrafts } from './hooks/useDraft';
import { ChatWindow } from './components/ChatWindow';
import { ChannelSidebar } from './components/ChannelSidebar';
import { LoginScreen } from './components/LoginScreen';
import { SetupWizard } from './components/SetupWizard';

/**
 * Uygulama Kökü.
 *
 * SORUMLULUKLARI
 *   · Oturum önyüklemesi (bootstrap)
 *   · WebSocket yaşam döngüsünün oturuma bağlanması
 *   · Çıkışta yerel durumun temizlenmesi
 *
 * Buradaki her etki (effect) bir kaynağı AÇAR ve temizleme fonksiyonunda
 * KAPATIR. Sohbet uygulamalarında en sık görülen bellek sızıntısı,
 * kapatılmayan socket bağlantıları ve zamanlayıcılardır.
 */
export function App() {
  const status = useAuth((s) => s.status);
  const accessToken = useAuth((s) => s.accessToken);
  const logoutReason = useAuth((s) => s.logoutReason);
  const [activeChannelId, setActiveChannelId] = useState<string | null>(null);
  const [bootstrapping, setBootstrapping] = useState(true);
  // `null` = henüz bilinmiyor (sorgu sürüyor). Bilerek `false` ile
  // başlatılmaz: kısa bir an için render edilecek yanlış bir ekran (giriş
  // ekranı → sihirbaza sıçrama) kullanıcıyı şaşırtır. Bkz. aşağıdaki
  // bootstrapping bloğu — `needsSetup === null` iken de yükleniyor gösterilir.
  const [needsSetup, setNeedsSetup] = useState<boolean | null>(null);
  // `npm run demo` ile çalışan bellek içi sunucuda `true` olur (bkz. aşağıdaki
  // efekt). Gerçek NestJS sunucusunda bu uç nokta yoktur (404) ve `false`
  // kalır. Amaç: demo veriyle oynayan birinin bunu gerçek bir kurulumla
  // KARIŞTIRMASINI imkânsız kılmak — bkz. DemoBanner.
  const [isDemo, setIsDemo] = useState(false);

  const userId = useAuth((s) => s.userId);
  const totalUnread = useChatStore(selectTotalUnread);
  const theme = usePreferences((s) => s.theme);

  // --- Oturum önyüklemesi --------------------------------------------------

  useEffect(() => {
    // Ateşle-unut: demo tespiti kritik yol DEĞİLDİR, `bootstrapping`i
    // beklemez. Gerçek sunucuda 404 alır ve sessizce `false` kalır.
    void fetch('/api/v1/demo-info', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { isDemo?: boolean } | null) => {
        if (data?.isDemo) setIsDemo(true);
      })
      .catch(() => undefined);

    void (async () => {
      // --- 1) Kurulum durumu ------------------------------------------------
      //
      // Taze kurulmuş bir sistemde hiçbir organizasyon yoktur; bu durumda
      // `/auth/me` zaten anlamsızdır ve giriş ekranını göstermek kullanıcıyı
      // asla giremeyeceği bir formla karşılaştırır. Bu kontrol, "kurulumu
      // az önce yükledim ve doğrudan bir demo sohbetine düştüm" sorununun
      // önüne geçen kapıdır.
      //
      // KENDİ AYRI try/catch'İ VARDIR — bu ADIM KRİTİKTİR: bu sorgu
      // başarısız olursa (eski bir sunucu sürümü, ağ sorunu, `/setup/status`
      // henüz olmayan bir dağıtım) normal oturum açma denemesini
      // ENGELLEMEMELİDİR. İkisini TEK bir try bloğunda birleştirmek gerçek
      // bir hataydı: kurulum sorgusundaki bir istisna, zaten geçerli bir
      // refresh çerezi olan bir kullanıcıyı bile giriş ekranına düşürüyordu.
      let setupNeeded = false;
      try {
        const statusResponse = await fetch('/api/v1/setup/status', { credentials: 'include' });
        if (statusResponse.ok) {
          const statusData = (await statusResponse.json()) as { needsSetup: boolean };
          setupNeeded = statusData.needsSetup;
        }
        // `ok` değilse (404 vb.) `setupNeeded` false kalır — güvenli varsayım:
        // kurulu bir sistemi yanlışlıkla sihirbaza düşürmek, henüz
        // kurulmamış birini yanlışlıkla giriş ekranına düşürmekten (orada
        // "org bulunamadı" görüp geri döner) daha yıkıcıdır.
      } catch {
        // Ağ hatası veya JSON olmayan yanıt — aynı güvenli varsayım.
      }

      setNeedsSetup(setupNeeded);
      if (setupNeeded) {
        setBootstrapping(false);
        return;
      }

      // --- 2) Oturum önyüklemesi ---------------------------------------------
      //
      // Sayfa yenilendiğinde erişim token'ı kaybolur (yalnızca bellekte
      // tutulur). Ancak httpOnly refresh çerezi durur — sessizce yeni bir
      // token alınır ve kullanıcı yeniden giriş yapmak zorunda kalmaz.
      try {
        await authStore.getState().refreshAccessToken();
        await authStore.getState().hydrateFromServer();
      } catch {
        // Refresh çerezi yok veya süresi dolmuş — giriş ekranı gösterilir.
        // Bu bir hata değil, beklenen ilk-ziyaret durumudur.
      } finally {
        setBootstrapping(false);
      }
    })();
  }, []);

  // --- WebSocket yaşam döngüsü ---------------------------------------------

  useEffect(() => {
    if (status !== 'authenticated' || !accessToken) return;

    realtimeClient.connect(accessToken);

    return () => {
      // Bağlantıyı KAPAT. Kapatılmazsa oturum değişiminde eski socket
      // açık kalır ve iki bağlantı aynı anda mesaj almaya devam eder.
      realtimeClient.disconnect();
    };
  }, [status, accessToken]);

  // --- Çıkış temizliği -----------------------------------------------------

  useEffect(() => {
    if (status !== 'unauthenticated') return;

    // Sohbet geçmişi ve taslaklar bellekten/sessionStorage'dan silinir.
    // Ortak kullanılan bir bilgisayarda bir sonraki kullanıcı, öncekinin
    // mesajlarını görmemelidir.
    useChatStore.getState().reset();
    clearAllDrafts();
    setActiveChannelId(null);
  }, [status]);

  // --- Tema -----------------------------------------------------------------

  useEffect(() => {
    // `applyTheme` bir temizleme fonksiyonu döndürür: 'system' seçiliyken
    // işletim sistemi tercihini dinler. Temizlenmezse tema her değişiminde
    // yeni bir dinleyici birikir.
    return applyTheme(theme);
  }, [theme]);

  // --- Sekme başlığında okunmamış rozeti -----------------------------------

  useEffect(() => {
    const base = 'iNCompany';
    document.title = totalUnread > 0 ? `(${totalUnread > 99 ? '99+' : totalUnread}) ${base}` : base;
  }, [totalUnread]);

  // --- Sekme görünürlüğü ---------------------------------------------------

  useEffect(() => {
    /**
     * Sekme yeniden görünür olduğunda senkronizasyonu tetikle.
     *
     * Tarayıcılar arka plandaki sekmelerde zamanlayıcıları kısar ve
     * WebSocket bağlantısını askıya alabilir. Geri dönüldüğünde bağlantı
     * "açık" görünse bile mesaj kaçırılmış olabilir; kalp atışı bunu
     * doğrular ve gerekirse yeniden bağlanma başlar.
     */
    const handler = (): void => {
      if (document.visibilityState === 'visible' && activeChannelId) {
        realtimeClient.subscribe([activeChannelId]);
      }
    };

    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  }, [activeChannelId]);

  // --- Render --------------------------------------------------------------

  let body: ReactNode;

  if (bootstrapping) {
    body = (
      <div className="flex h-full items-center justify-center bg-slate-100 dark:bg-slate-950">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-slate-300 border-t-indigo-600 motion-reduce:animate-none" />
          <p className="text-sm text-slate-500">Yükleniyor…</p>
        </div>
      </div>
    );
  } else if (needsSetup) {
    body = (
      <SetupWizard
        onComplete={() => {
          setNeedsSetup(false);
          // authStore.setSession zaten SetupWizard içinde çağrıldı; burada
          // yalnızca bu bileşenin "sihirbaz mı, uygulama mı" kararını
          // günceller ve normal render yoluna geri döner (status artık
          // 'authenticated' olduğu için aşağıdaki asıl uygulama render edilir).
        }}
      />
    );
  } else if (status !== 'authenticated') {
    body = <LoginScreen reason={logoutReason} />;
  } else {
    body = (
      <div className="flex h-full overflow-hidden bg-slate-100 dark:bg-slate-950">
        <ChannelSidebar
          activeChannelId={activeChannelId}
          onSelectChannel={setActiveChannelId}
        />

        <main className="flex min-w-0 flex-1 overflow-hidden">
          {activeChannelId ? (
            <ChatWindow channelId={activeChannelId} currentUserId={userId} />
          ) : (
            <EmptyState />
          )}
        </main>
      </div>
    );
  }

  // `h-full`, `h-screen` DEĞİL.
  //
  // İki neden: (1) `100vh` mobil tarayıcılarda adres çubuğu yüzünden
  // görünür alandan büyüktür, alt kısım kesilir; (2) bazı gömülü
  // bağlamlarda `vh` sıfıra çözülür ve tüm düzen çöker. html → body →
  // #root zinciri `h-full` olduğu için yüzde tabanlı zincir her yerde çalışır.
  //
  // `isDemo` banner'ı BURADA, tek bir kökte gösterilir — sihirbaz, giriş
  // ekranı veya asıl uygulama fark etmeksizin HER durumda görünür olması
  // için. Alt ağaçtaki `h-full` kullanımları artık `flex-1 min-h-0`
  // kapsayıcısına göre çözülür; bu, gerçek bir yükseklik veren bir flex
  // ebeveyni olduğu için sorunsuz çalışır.
  return (
    <div className="flex h-full flex-col overflow-hidden">
      {isDemo && <DemoBanner />}
      <div className="min-h-0 flex-1">{body}</div>
    </div>
  );
}

/**
 * Demo modu banner'ı.
 *
 * Kalıcı, göz ardı edilemez, kapatılamaz. Bir açık/kapa düğmesi eklemek
 * cazip görünebilir ama amacı yener: kullanıcı bir kez kapatır, unutur ve
 * demo verisiyle üretim verisini karıştırır. Bu banner'ın varlığı, tam
 * olarak bu karışıklığı önlemek için vardır.
 */
function DemoBanner() {
  return (
    <div
      role="status"
      className="flex shrink-0 items-center justify-center gap-2 bg-amber-500 px-4 py-1.5
                 text-center text-xs font-medium text-amber-950"
    >
      <span aria-hidden="true">🧪</span>
      DEMO MODU — bu gerçek bir kurulum değildir, veriler kalıcı değildir ve
      her yeniden başlatmada sıfırlanır. Gerçek kurulum için{' '}
      <code className="rounded bg-amber-600/30 px-1 py-0.5 font-mono">./setup.sh</code> çalıştırın.
    </div>
  );
}

/** Hiçbir kanal seçilmediğinde gösterilen karşılama ekranı. */
function EmptyState() {
  return (
    <div className="flex h-full w-full items-center justify-center bg-white px-6 dark:bg-slate-900">
      <div className="max-w-sm text-center">
        <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-indigo-50 text-2xl dark:bg-indigo-950">
          💬
        </div>
        <h2 className="mb-1.5 text-lg font-semibold text-slate-900 dark:text-slate-100">
          iNCompany’e hoş geldiniz
        </h2>
        <p className="text-sm leading-relaxed text-slate-500 dark:text-slate-400">
          Soldaki listeden bir kanal veya kişi seçerek sohbete başlayın.
          Mesajlarınız sunucuda AES-256-GCM ile şifrelenerek saklanır.
        </p>
      </div>
    </div>
  );
}
