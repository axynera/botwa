# BotWA Plugins

Folder untuk plugin yang akan kamu upload dan simpan di repository.

## Upload plugin

Letakkan file plugin `.js` atau `.mjs` di folder ini, misalnya:

```text
plugins/
├── README.md
├── sticker.js
├── downloader.js
└── game.js
```

Plugin diproses oleh sistem plugin BotWA. Plugin biasa dapat menangani pesan terlebih dahulu. Jika tidak ada plugin yang menangani pesan, pesan dapat diteruskan ke AI chat sebagai fallback dengan sistem thinking AI.

> Jangan menyimpan API key, token, password, atau credential pribadi di folder ini.

## Format plugin

Gunakan format plugin yang kompatibel dengan loader BotWA. Plugin harus mengembalikan `true` setelah menangani pesan agar dispatcher tidak meneruskan pesan yang sama ke plugin berikutnya.

Folder ini disiapkan sebagai tempat upload plugin; konfigurasi runtime dan sinkronisasi plugin mengikuti konfigurasi aplikasi.
