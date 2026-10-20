# Chrome Web Store listing

Everything to paste into the developer dashboard. Keep it in sync with `wxt.config.ts`, `public/_locales/` and `PRIVACY.md`.

## Package

`npm run zip` → upload `.output/igdiff-<version>-chrome.zip`.

## Store listing tab

**Name** (from `public/_locales/en/messages.json`, 54 of 75 characters; the store searches it first):
IgDiff: Unfollowers & Not Following Back for Instagram

**Summary** (from `public/_locales/en/messages.json`, 120 of 132 characters):
See who unfollowed you and who doesn't follow you back on Instagram. Free, no password, and nothing leaves your browser.

**Category:** Social Networking. **Language:** English (the manifest's `default_locale`). Spanish, Brazilian Portuguese, Indonesian and Turkish are under [Translated listings](#translated-listings).

**Description** (say "Instagram" at most five times: the store treats more as keyword spam):

```
See who unfollowed you on Instagram and who doesn't follow you back, automatically. IgDiff is free and open source. It never asks for your password, and your data never leaves your browser.

Stay signed in as usual. IgDiff reads your followers and following in the background from your open tab (about 20 seconds for 1,000 accounts) and keeps a daily snapshot, so you can see exactly who came and went.

WHAT YOU GET
• Unfollowers: who unfollowed you, day by day. Each one is double-checked before it shows up.
• Not following back: everyone you follow who doesn't follow you back
• Fans: people who follow you that you don't follow back
• Mutuals
• Follower and following counts, with a 7-day change and a follower graph
• Unfollow, remove followers or follow back, one at a time or in bulk, at a slow, safe pace (at most 100 a day; it stops at the first sign of trouble)
• Keep list: star accounts you never want to unfollow or remove
• A toolbar badge when someone unfollows you
• Sort by recent, oldest or A–Z, search, and export to CSV or JSON
• Light and dark mode

PRIVATE BY DESIGN
• No login: it uses the session you already have in your browser
• No servers: everything is stored on your computer, and nothing is sent anywhere else
• No tracking, no ads, no analytics
• Delete everything with one click
• Open source: anyone can read the code on GitHub

QUESTIONS
How do I see who unfollowed me?
Install IgDiff and open your account in a signed-in tab. The first sync shows who doesn't follow you back right away. After that, IgDiff compares each day's snapshot with the last and lists anyone who unfollowed you.

Does it need my password?
No. It works inside your own signed-in tab and never sees your password.

Will my account get blocked?
IgDiff reads your lists once a day. Unfollows and removals go one at a time, 15 to 35 seconds apart, at most 100 a day, and stop the moment anything looks wrong.

Does it work on my phone?
No. It's a Chrome extension, so it runs on a computer.

Is it free?
Yes. There's no premium tier and no account to create.

HOW TO USE
1. Install IgDiff and pin it to the toolbar.
2. Open instagram.com, signed in. Your first sync starts on its own.
3. Click the IgDiff icon to open the side panel.

IgDiff is not affiliated with, endorsed by, or sponsored by Instagram or Meta. Instagram is a trademark of Instagram, LLC.
```

**Graphics** (in `store-assets/`):

| Field | File |
|---|---|
| Store icon (128×128) | `public/icon/128.png` |
| Screenshots (1280×800) | `store-assets/1-dont-follow-back.png` … `5-private.png` |
| Small promo tile (440×280) | `store-assets/promo-tile-440x280.png` |

The screenshots use fictional demo accounts, not real people.

## Translated listings

Real translations of the English listing, so the store page can show up when people search in these languages. Add a language only with an honest translation of the whole listing: keywords in languages the listing isn't written in count as spam under the store's policy.

- **Name and summary** come from `public/_locales/<lang>/messages.json` inside the zip. Nothing to paste.
- **Description:** once a zip that includes `_locales` is uploaded, pick each language from the Store listing tab's language menu and paste its block below into Description.
- **Graphics:** use the English screenshots and promo tile for every language, since the app itself is in English.
- Like the English one, each description says "Instagram" five times, no more. Each one also says the app is in English for now.

| Locale | Name (of 75) | Summary (of 132) |
|---|---|---|
| `en` English | 54 | 120 |
| `es` Spanish | 66 | 127 |
| `pt_BR` Portuguese (Brazil) | 68 | 119 |
| `id` Indonesian | 64 | 130 |
| `tr` Turkish | 65 | 127 |

### Spanish (`es`)

```
Descubre quién dejó de seguirte en Instagram y quién no te sigue de vuelta, de forma automática. IgDiff es gratis y de código abierto. Nunca te pide la contraseña y tus datos nunca salen de tu navegador.

Mantén la sesión iniciada como siempre. IgDiff lee tus seguidores y seguidos en segundo plano desde tu pestaña abierta (unos 20 segundos por cada 1000 cuentas) y guarda una instantánea diaria, para que veas exactamente quién llegó y quién se fue.

Por ahora, la interfaz de IgDiff solo está en inglés.

QUÉ INCLUYE
• Unfollowers: las cuentas que dejaron de seguirte, día a día. Cada una se comprueba dos veces antes de aparecer.
• No te siguen de vuelta: todas las cuentas que sigues y que no te siguen
• Fans: personas que te siguen y a las que tú no sigues
• Seguidores mutuos
• Número de seguidores y seguidos, con la variación de los últimos 7 días y un gráfico de seguidores
• Deja de seguir, elimina seguidores o sigue de vuelta, de uno en uno o en bloque, a un ritmo lento y seguro (como máximo 100 al día; se detiene al primer indicio de problemas)
• Lista de excepciones: marca con una estrella las cuentas que nunca quieras dejar de seguir ni eliminar
• Un aviso en el icono de la barra de herramientas cuando alguien deja de seguirte
• Ordena por recientes, más antiguos o A–Z, busca y exporta a CSV o JSON
• Modo claro y oscuro

PRIVACIDAD DESDE EL DISEÑO
• Sin inicio de sesión: usa la sesión que ya tienes abierta en tu navegador
• Sin servidores: todo se guarda en tu equipo y no se envía a ningún otro sitio
• Sin rastreo, sin anuncios, sin analíticas
• Borra todo con un clic
• Código abierto: cualquiera puede leer el código en GitHub

PREGUNTAS
¿Cómo veo quién dejó de seguirme?
Instala IgDiff y abre tu cuenta en una pestaña con la sesión iniciada. La primera sincronización te muestra al momento quién no te sigue de vuelta. Después, IgDiff compara la instantánea de cada día con la anterior y te muestra quién dejó de seguirte.

¿Necesita mi contraseña?
No. Funciona dentro de tu propia pestaña con la sesión iniciada y nunca ve tu contraseña.

¿Me pueden bloquear la cuenta?
IgDiff lee tus listas una vez al día. Las acciones de dejar de seguir y eliminar seguidores se hacen de una en una, con 15 a 35 segundos entre cada una, como máximo 100 al día, y se detienen en cuanto algo parece ir mal.

¿Funciona en el teléfono?
No. Es una extensión de Chrome, así que funciona en la versión de escritorio del navegador.

¿Es gratis?
Sí. No hay versión premium ni cuenta que crear.

CÓMO USARLO
1. Instala IgDiff y fíjalo en la barra de herramientas.
2. Abre instagram.com con la sesión iniciada. La primera sincronización empieza sola.
3. Haz clic en el icono de IgDiff para abrir el panel lateral.

IgDiff no está afiliado a Instagram ni a Meta, ni cuenta con su respaldo o patrocinio. Instagram es una marca comercial de Instagram, LLC.
```

### Portuguese, Brazil (`pt_BR`)

```
Veja quem deixou de te seguir no Instagram e quem não te segue de volta, automaticamente. O IgDiff é gratuito e de código aberto. Ele nunca pede sua senha, e seus dados nunca saem do seu navegador.

Continue conectado como sempre. O IgDiff lê seus seguidores e quem você segue em segundo plano, na aba que já está aberta (cerca de 20 segundos para 1.000 contas), e guarda um registro diário, para você ver exatamente quem chegou e quem saiu.

Por enquanto, a interface do IgDiff está só em inglês.

O QUE ESTÁ INCLUÍDO
• Unfollowers: quem deixou de te seguir, dia a dia. Cada um é conferido duas vezes antes de aparecer.
• Não te seguem de volta: todo mundo que você segue e que não te segue
• Fãs: quem te segue, mas você não segue de volta
• Seguidores mútuos
• Número de seguidores e de quem você segue, com a variação de 7 dias e um gráfico de seguidores
• Deixe de seguir, remova seguidores ou siga de volta, um por vez ou em massa, num ritmo lento e seguro (no máximo 100 por dia; ele para no primeiro sinal de problema)
• Lista de exceções: marque com estrela as contas que você nunca quer deixar de seguir nem remover
• Um aviso no ícone da barra de ferramentas quando alguém deixa de te seguir
• Ordene por mais recentes, mais antigos ou A–Z, pesquise e exporte para CSV ou JSON
• Modo claro e escuro

PRIVACIDADE EM PRIMEIRO LUGAR
• Sem login: usa a sessão que você já tem no navegador
• Sem servidores: tudo fica salvo no seu computador, e nada é enviado para nenhum outro lugar
• Sem rastreamento, sem anúncios, sem análises
• Apague tudo com um clique
• Código aberto: qualquer pessoa pode ler o código no GitHub

PERGUNTAS
Como vejo quem deixou de me seguir?
Instale o IgDiff e abra sua conta em uma aba conectada. A primeira sincronização já mostra quem não te segue de volta. Depois disso, o IgDiff compara o registro de cada dia com o anterior e lista quem deixou de te seguir.

Ele precisa da minha senha?
Não. Ele funciona dentro da sua própria aba conectada e nunca vê sua senha.

Minha conta pode ser bloqueada?
O IgDiff lê suas listas uma vez por dia. As ações de deixar de seguir e remover seguidores acontecem uma de cada vez, com 15 a 35 segundos de intervalo, no máximo 100 por dia, e param assim que algo parecer errado.

Funciona no celular?
Não. É uma extensão do Chrome, então funciona no computador.

É grátis?
Sim. Não há plano premium nem conta para criar.

COMO USAR
1. Instale o IgDiff e fixe-o na barra de ferramentas.
2. Abra o instagram.com com sua conta conectada. A primeira sincronização começa sozinha.
3. Clique no ícone do IgDiff para abrir o painel lateral.

O IgDiff não é afiliado ao Instagram nem à Meta, e não é endossado nem patrocinado por eles. Instagram é uma marca registrada da Instagram, LLC.
```

### Indonesian (`id`)

```
Lihat siapa yang unfollow kamu di Instagram dan siapa yang tidak follow balik, secara otomatis. IgDiff gratis dan open source, tidak pernah meminta kata sandi kamu, dan data kamu tidak pernah keluar dari browser.

Tetap login seperti biasa. IgDiff membaca daftar pengikut dan akun yang kamu ikuti di latar belakang dari tab yang sedang terbuka (sekitar 20 detik untuk 1.000 akun) dan menyimpan snapshot setiap hari, jadi kamu bisa melihat dengan jelas siapa yang datang dan siapa yang pergi.

Untuk saat ini, tampilan IgDiff baru tersedia dalam bahasa Inggris.

FITUR
• Unfollowers: siapa yang unfollow kamu, hari demi hari. Setiap akun dicek dua kali sebelum ditampilkan.
• Tidak follow balik: semua akun yang kamu ikuti tetapi tidak mengikuti kamu balik
• Fans: orang yang mengikuti kamu tetapi tidak kamu ikuti balik
• Mutual (saling mengikuti)
• Jumlah pengikut dan yang diikuti, dengan perubahan 7 hari terakhir dan grafik pengikut
• Unfollow, hapus pengikut, atau follow balik, satu per satu atau sekaligus, dengan tempo lambat dan aman (maksimal 100 per hari; langsung berhenti begitu ada tanda masalah)
• Daftar pengecualian: beri bintang pada akun yang tidak ingin kamu unfollow atau hapus
• Tanda di ikon toolbar saat ada yang unfollow kamu
• Urutkan dari yang terbaru, terlama, atau A–Z, cari, dan ekspor ke CSV atau JSON
• Mode terang dan gelap

PRIVASI SEJAK AWAL
• Tanpa login tambahan: memakai sesi yang sudah ada di browser kamu
• Tanpa server: semua data disimpan di komputer kamu dan tidak dikirim ke mana pun
• Tanpa pelacakan, tanpa iklan, tanpa analitik
• Hapus semua data dengan satu klik
• Open source: siapa pun bisa membaca kodenya di GitHub

PERTANYAAN
Bagaimana cara melihat siapa yang unfollow saya?
Pasang IgDiff, lalu buka akun kamu di tab yang sudah login. Sinkronisasi pertama langsung menampilkan siapa yang tidak follow balik. Setelah itu, IgDiff membandingkan snapshot setiap hari dengan hari sebelumnya dan menampilkan siapa saja yang unfollow kamu.

Apakah perlu kata sandi saya?
Tidak. Ekstensi ini bekerja di dalam tab kamu sendiri yang sudah login dan tidak pernah melihat kata sandi kamu.

Apakah akun saya bisa diblokir?
IgDiff membaca daftar kamu sekali sehari. Unfollow dan hapus pengikut dilakukan satu per satu, dengan jeda 15 sampai 35 detik, maksimal 100 per hari, dan langsung berhenti begitu ada yang tidak beres.

Apakah bisa dipakai di HP?
Tidak. Ini ekstensi Chrome, jadi berjalan di komputer.

Apakah gratis?
Ya. Tidak ada versi premium dan tidak perlu membuat akun.

CARA PAKAI
1. Pasang IgDiff dan sematkan di toolbar.
2. Buka instagram.com dalam keadaan login. Sinkronisasi pertama akan berjalan sendiri.
3. Klik ikon IgDiff untuk membuka panel samping.

IgDiff tidak berafiliasi dengan Instagram maupun Meta, dan tidak didukung atau disponsori oleh keduanya. Instagram adalah merek dagang milik Instagram, LLC.
```

### Turkish (`tr`)

```
Instagram'da seni takipten çıkanları ve seni geri takip etmeyenleri otomatik olarak gör. IgDiff ücretsiz ve açık kaynaklıdır. Şifreni asla istemez ve verilerin asla tarayıcından çıkmaz.

Her zamanki gibi oturumunu açık tut. IgDiff, açık sekmen üzerinden takipçilerini ve takip ettiklerini arka planda okur (1.000 hesap için yaklaşık 20 saniye) ve her gün bir anlık görüntü kaydeder; böylece kimin gelip kimin gittiğini tam olarak görürsün.

IgDiff'in arayüzü şimdilik yalnızca İngilizce.

ÖZELLİKLER
• Takipten çıkanlar: seni takipten çıkanları gün gün gör. Her biri listede görünmeden önce iki kez kontrol edilir.
• Geri takip etmeyenler: takip ettiğin ama seni geri takip etmeyen herkes
• Hayranlar: seni takip eden ama senin geri takip etmediğin kişiler
• Karşılıklı takipleşenler
• Takipçi ve takip edilen sayıları, 7 günlük değişim ve takipçi grafiğiyle
• Takipten çık, takipçi kaldır ya da geri takip et; tek tek veya toplu olarak, yavaş ve güvenli bir hızda (günde en fazla 100; ilk sorun belirtisinde durur)
• İstisna listesi: asla takipten çıkmak ya da kaldırmak istemediğin hesapları yıldızla
• Biri seni takipten çıktığında araç çubuğu simgesinde bildirim rozeti
• En yeniye, en eskiye veya A–Z'ye göre sırala, ara ve CSV ya da JSON olarak dışa aktar
• Açık ve koyu mod

GİZLİLİK ÖN PLANDA
• Giriş yok: tarayıcında zaten açık olan oturumu kullanır
• Sunucu yok: her şey bilgisayarında saklanır, başka hiçbir yere gönderilmez
• İzleme yok, reklam yok, analiz yok
• Tek tıkla her şeyi sil
• Açık kaynak: kodu herkes GitHub'da okuyabilir

SORULAR
Beni takipten çıkanları nasıl görürüm?
IgDiff'i yükle ve hesabını oturumunun açık olduğu bir sekmede aç. İlk senkronizasyon, seni geri takip etmeyenleri hemen gösterir. Sonrasında IgDiff her günün anlık görüntüsünü bir öncekiyle karşılaştırır ve seni takipten çıkan herkesi listeler.

Şifreme gerek var mı?
Hayır. Oturumunun açık olduğu kendi sekmende çalışır ve şifreni asla görmez.

Hesabım engellenir mi?
IgDiff listelerini günde bir kez okur. Takipten çıkma ve takipçi kaldırma işlemleri tek tek, aralarında 15 ila 35 saniye bırakılarak, günde en fazla 100 tane yapılır ve bir terslik görüldüğü anda durur.

Telefonumda çalışır mı?
Hayır. Bir Chrome uzantısı olduğu için bilgisayarda çalışır.

Ücretsiz mi?
Evet. Premium sürüm yok, hesap oluşturman da gerekmez.

NASIL KULLANILIR
1. IgDiff'i yükle ve araç çubuğuna sabitle.
2. Oturumun açıkken instagram.com'u aç. İlk senkronizasyon kendiliğinden başlar.
3. Yan paneli açmak için IgDiff simgesine tıkla.

IgDiff'in Instagram veya Meta ile bir bağlantısı yoktur; onlar tarafından onaylanmamış ya da desteklenmemiştir. Instagram, Instagram, LLC'nin ticari markasıdır.
```

## Privacy practices tab

**Single purpose:**
Shows who doesn't follow you back on Instagram, your mutuals and fans, and who unfollowed you over time, and lets you unfollow, remove or follow back accounts you choose.

**Permission justifications:**

| Permission | Justification |
|---|---|
| Host access to `https://www.instagram.com/*` | The follow lists are read from the user's signed-in Instagram tab, with their own session. The content script runs only on www.instagram.com and renders nothing into the page. |
| `storage` | Stores the sync schedule, today's request and action counts, and the queue of a running batch of unfollows, removals or follow-backs, so they survive the background worker restarting. |
| `unlimitedStorage` | Follower history and profile pictures live in IndexedDB. Without this, Chrome may evict them under disk pressure and the user would lose their history. |
| `alarms` | Rechecks every 30 minutes whether the daily sync is due, for Instagram tabs that stay open for days. |
| `sidePanel` | The extension's whole interface is a side panel opened from the toolbar button. |

**Remote code:** No. Everything that runs ships in the package. The bundle contains no `eval`, and nothing is fetched or executed from a server.

**Data usage:** tick **Personally identifiable information** (usernames and names of the user's followers and followings) and **Website content** (follow lists, profile pictures). All of it stays on the user's device.

Certify all three: not sold to third parties, not used for purposes unrelated to the single purpose, not used to determine creditworthiness.

**Privacy policy URL:** https://github.com/mzhao1599/igdiff/blob/main/PRIVACY.md

(Version 0.1.0 was submitted with `.../blob/main/extension/PRIVACY.md`. That copy stays until the dashboard points at the new address.)

**Homepage URL:** https://github.com/mzhao1599/igdiff · **Support URL:** https://github.com/mzhao1599/igdiff/issues

## Before submitting

- [ ] Bump `version` in `package.json` for every new upload. The store rejects a version it has already seen.
- [ ] `npm run zip` and upload the zip.
- [ ] Check the name. Instagram's brand guidelines have asked third-party apps not to use "IG", "Insta" or "Gram" in their names; a trademark complaint could force a rename later.
