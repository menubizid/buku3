# Panduan Lengkap Kelas Membaca v5

Kelas Membaca adalah platform membaca bersama: timer membaca fokus, catatan bacaan, rak buku pribadi dengan sampul dari Google Drive, kelas batch 30 hari dengan 10 tugas terjadwal, papan peringkat, dan panel admin untuk mentor.

Dokumen ini ditujukan untuk tiga peran: **pengelola teknis** (memasang), **mentor/admin** (mengelola kelas dan anggota), dan **anggota** (memakai aplikasi).

Berkas proyek (tiga berkas):

| Berkas | Fungsi |
|---|---|
| `panduan-kelas-membaca.md` | Panduan ini |
| `code.gs` | Backend Google Apps Script (REST API) yang menyimpan data di Google Spreadsheet dan sampul di Google Drive |
| `kelas-membaca-theme.xml` | Tema Blogger (layoutsVersion 3) berisi aplikasi single-page: landing page + aplikasi |

---

## 1. Gambaran Singkat

- **Frontend**: tema Blogger satu halaman, layar penuh. Tidak perlu widget tambahan.
- **Backend**: Google Apps Script sebagai Web App (`/exec`), berkomunikasi lewat `POST` berformat `{action, token, data}`.
- **Penyimpanan**: Google Spreadsheet (satu tabel per entitas), sampul buku di folder Google Drive `Kelas Membaca - Sampul Buku` (dibuat otomatis).
- **Grafik**: Chart.js (dual bar: merah muda `#F4A3B8` untuk halaman, mint `#88DCD6` untuk menit).
- **Notifikasi**: toast dan dialog konfirmasi di dalam aplikasi.

### Peran pengguna

| Peran | Yang bisa dilakukan |
|---|---|
| **Tamu (Guest)** | Melihat landing page, katalog buku publik, dan form masuk/daftar. |
| **Anggota (Member)** | Semua fitur pembaca: rak buku, timer, catatan, komentar, jelajah, kelas, tugas, peringkat, profil. |
| **Admin** | Semua fitur anggota + panel admin: kelola anggota, impersonasi, evaluasi batch, backup/restore JSON. |

Akun pertama yang mendaftar otomatis menjadi **Admin**. Email yang tercantum di Script Property `ADMIN_EMAILS` juga otomatis menjadi Admin.

---

## 2. Persiapan Google (sekali saja)

### 2.1 Buat Google Spreadsheet
1. Buka Google Sheets, buat spreadsheet kosong.
2. Salin ID-nya: teks di antara `/d/` dan `/edit` pada URL.
   Contoh: `https://docs.google.com/spreadsheets/d/ABC123/edit` → ID = `ABC123`.

### 2.2 Pasang kode backend
1. Di spreadsheet: **Extensions > Apps Script**.
2. Hapus isi `Code.gs`, lalu tempel seluruh isi `code.gs`. Simpan.
3. **Project Settings > Script Properties**, tambahkan (opsional):

| Properti | Isi | Wajib? |
|---|---|---|
| `SPREADSHEET_ID` | ID spreadsheet dari 2.1 | Disarankan. Jika kosong, memakai ID default di konfigurasi. |
| `ADMIN_EMAILS` | Email mentor, dipisah koma | Opsional |
| `MAIL_NAME` | Nama pengirim email reset kata sandi | Opsional |

`COVER_FOLDER_ID` akan terisi otomatis saat pertama kali ada unggahan sampul.

4. Pilih fungsi **`setupDatabase`** di editor lalu klik **Run**. Setujui izin (Sheets, Drive, Gmail). Fungsi ini membuat semua tabel dan header kolom. Jalankan cukup sekali.
5. (Opsional tetapi disarankan) Pilih fungsi **`kmInstallDailyTrigger`** lalu Run. Ini memasang pemicu harian yang mengevaluasi kelas batch yang sudah lewat tanggal berakhir: peserta yang lulus diberi kelulusan, lalu batch dipindah ke kelas alumni.

### 2.3 Deploy Web App
1. Klik **Deploy > New deployment**.
2. Pilih tipe **Web app**.
3. Isi:
   - **Execute as**: *Me* (akun Anda)
   - **Who has access**: *Anyone*
4. Klik **Deploy**, setujui izin bila diminta, lalu salin **URL Web App** yang berakhiran `/exec`.

> Setiap kali kode `code.gs` diubah, gunakan **Deploy > Manage deployments > Edit > New version**, agar URL tetap sama.

---

## 3. Pasang Tema di Blogger

1. Buat blog baru di Blogger (atau gunakan blog yang sudah ada).
2. Buka **Tema > Cadangkan/Pulihkan > Unggah**, lalu pilih `kelas-membaca-theme.xml`.
   Alternatif: **Tema > Edit HTML**, hapus semua isinya, tempel seluruh isi berkas, lalu **Simpan**.
3. **Ganti URL API**: di Edit HTML, cari teks `REPLACE_WITH_DEPLOYMENT_ID` (ada di objek `CFG`, bagian `API_URL`) lalu ganti dengan bagian ID dari URL `/exec`.

   ```
   API_URL: 'https://script.google.com/macros/s/ID_DEPLOYMENT_ANDA/exec'
   ```

   Tempel URL lengkap yang Anda salin di 2.3 sebagai nilai `API_URL`. Pastikan tetap di dalam tanda kutip.
4. Simpan tema lalu buka blog. Jika tombol masuk atau daftar tidak berfungsi, aplikasi menampilkan pesan "URL API belum diatur": ulangi langkah 3.

> Aplikasi dibuat untuk **layar penuh**: bagian header dan widget Blogger disembunyikan. Anda cukup membuka alamat blog.

---

## 4. Tur Aplikasi

### 4.1 Landing page (Tamu)
- **Navbar lengket** dengan menu: Fitur, Kelas, Buku, Harga, FAQ. Tombol **Masuk** dan **Daftar** tersedia di pojok kanan.
- **Hero**: judul utama, ajakan, dan **Masuk cepat** (email/username dan kata sandi) langsung di halaman.
- **Bukti sosial**, **Fitur**, **Kelas pendampingan**, **Pembiasaan** (habit building), **Manfaat**, **Buku terbaru** (katalog publik, bergaya seperti Pustaloka), **Testimoni**, **Harga**, **FAQ**, **CTA**, dan **Footer**.
- Animasi muncul saat digulir, dengan urutan bertahap. Animasi dimatikan otomatis bagi pengguna yang mengaktifkan "kurangi gerakan" di perangkat.

### 4.2 Daftar dan masuk
- **Daftar**: nama, username, email, kata sandi (minimal 8 karakter, memuat huruf dan angka). Username otomatis diisi jika terlalu pendek.
- **Masuk**: email atau username + kata sandi. Setelah 10 kali gagal dalam 15 menit, login dibatasi sementara.
- **Lupa kata sandi**: dua langkah. Minta kode (berlaku 15 menit, maksimal 5 percobaan), lalu masukkan kode dan kata sandi baru.
- **Keluar** tersedia di sidebar (desktop) dan menu "Lainnya" (mobile).

### 4.3 Navigasi
- **Desktop (≥ 861 px)**: sidebar kiri berisi Beranda, Buku Saya, Jelajah, Kelas, Tugas, Peringkat, Profil, dan Admin (khusus admin).
- **Mobile (≤ 860 px)**: bilah navigasi bawah dengan tombol **Baca** (FAB) di tengah. Tombol **Baca** membuka Timer.
- Menu tambahan dibuka lewat **Lainnya** (sheet dari bawah).

### 4.4 Beranda
- Kartu statistik: halaman dibaca, menit efektif, streak, buku selesai, dan target harian (35 halaman).
- **Lanjut membaca**: karusel buku aktif. Jika belum ada buku, muncul ajakan menambah buku.
- **Rekomendasi**: lima aturan yang memberi saran kontekstual, misalnya "Catat bacaan hari ini", "Target belum tercapai", atau saran untuk buku yang lama tidak dibuka.
- **Kalender 30 hari** dan grafik harian (Chart.js). Jika Chart.js gagal dimuat, grafik diganti pesan "Grafik membutuhkan Chart.js. Periksa koneksi internet Anda."

### 4.5 Smart Reading Timer (Baca)
1. Klik **Baca** (mobile) atau **Mulai membaca** (beranda/detail buku).
2. Pilih buku dari rak atau isi buku baru, lalu **Mulai**. Timer tampil layar penuh.
3. **Jeda / Lanjutkan** menghentikan hitungan. Waktu saat jeda tidak dihitung sebagai menit efektif.
4. **Minimalkan** menyimpan timer ke pil kecil di layar. Klik pil untuk membukanya kembali.
5. **Selesai** membuka form catatan dengan durasi, menit efektif, dan buku sudah terisi. Isi halaman mulai dan selesai, lalu tulis insight, lalu **Simpan**.
6. **Batal** membuang sesi. Timer disimpan di perangkat, jadi tetap ada setelah halaman dimuat ulang.

### 4.6 Catatan bacaan (Catat sesi)
- Dibuka dari **Catat sesi** di halaman buku, atau dari hasil timer. Jika ada buku yang sedang dibaca, buku terakhir otomatis dipilih.
- **Stepper** (tombol ±) untuk halaman mulai/selesai, durasi total, dan menit efektif. Nilai langsung dihitung menjadi halaman dibaca dan persentase efektif.
- **Insight** wajib minimal 3 karakter. Tanggal tidak boleh di masa depan.
- **Privasi**: centang "Tampilkan catatan ini ke komunitas" atau biarkan kosong untuk catatan privat.
- Anda bisa mengedit atau menghapus catatan sendiri. Menghapus catatan menghitung ulang progres buku.

### 4.7 Buku Saya (CRUD buku)
- **Tambah buku**: judul, penulis, topik, total halaman, halaman saat ini, dan **sampul** (opsional).
- **Filter status**: Semua, Sedang dibaca, Belum dibaca, Selesai.
- **Edit**: ubah data buku, ganti sampul, atau hapus sampul.
- **Hapus buku**: meminta konfirmasi. Catatan terkait ikut terhapus.
- **Detail buku**: progres, daftar catatan (timeline), dan komentar. Tombol **Catat sesi** hanya tampil untuk pemilik buku.

#### Sampul buku (Google Drive)
- Format yang diterima: **JPG, PNG, atau WebP**, maksimal **3 MB**.
- Berkas disimpan di folder Drive **Kelas Membaca - Sampul Buku**, lalu aplikasi menampilkannya dari Drive.
- Mengganti sampul menghapus berkas lama. Menghapus sampul juga menghapus berkasnya dari Drive.
- Untuk sampul dari URL luar, gunakan alamat `https://`.

### 4.8 Jelajah
- Jelajah memiliki empat tab: **Buku** (buku publik anggota lain), **Orang** (cari anggota), **Teman** (daftar pertemanan), dan **Topik** (telusuri buku per topik).
- Dari profil anggota Anda dapat menambah atau menghapus **pertemanan**, serta membuka **rak buku** mereka lewat modal tanpa meninggalkan halaman.

### 4.9 Kelas (batch 30 hari)
- Setiap kelas berdurasi **30 hari**: nama, deskripsi, jenis kelas, nomor batch, mentor, target halaman per hari, syarat lulus, status, tanggal mulai dan berakhir, serta tanggal tutup pendaftaran.
- **Gabung kelas**: anggota bergabung ke kelas yang masih terbuka.
- **Buat 10 tugas**: tombol **Generate tugas** membuat 10 tugas terjadwal sekaligus.
- **Syarat lulus** (default): minimal **6 tugas** selesai dan minimal **1000 halaman** dibaca.
- **Alumni**: kelas yang sudah lewat tanggal berakhir dievaluasi lalu dipindah ke kelas alumni (otomatis jika pemicu harian aktif, atau manual lewat panel admin).

### 4.10 Tugas
- Tugas ditampilkan per kelas dengan status dan tanggal aktif.
- **Form dinamis**: setiap tugas memiliki pertanyaan sendiri. Jenis isian: teks, teks panjang, angka, URL, tanggal, pilihan tunggal (radio), pilihan (select), dan centang.
- **Validasi**: tugas bisa mensyaratkan jumlah halaman minimal, kategori, atau buku tertentu.
- **Submit**: jawaban dikirim dan tercatat. Mentor meninjau lalu memberi skor (0–100) dan feedback.
- **Editor tugas (mentor/admin)**: tambah, ubah, atau hapus pertanyaan dan aturan. Judul wajib diisi.

### 4.11 Peringkat
- Papan peringkat per kelas dengan rentang hari (misalnya 7, 14, atau 30 hari) berdasarkan halaman dan menit efektif.
- Anggota yang lulus ditandai.

### 4.12 Profil
- Ubah nama, username, bio, avatar (URL), dan pengaturan WhatsApp.
- **Ganti kata sandi**: masukkan kata sandi lama, lalu kata sandi baru dua kali. Kata sandi lama yang salah ditolak.

### 4.13 Panel Admin
Tab **Anggota**:
- Tabel anggota dengan pencarian dan peran.
- **Tambah anggota**, **edit** (nama, username, email, peran, bio), dan **hapus**. Admin tidak bisa menurunkan peran dirinya sendiri.
- **Progres anggota**: KPI, grafik, dan riwayat bacaan.
- **Masuk sebagai (impersonasi)**: admin masuk sebagai anggota untuk membantu. Spanduk peringatan tampil di atas. Klik **Keluar dari impersonasi** untuk kembali. Hanya admin yang bisa melakukannya.

Tab **Operasional**:
- **Evaluasi batch (lifecycle)**: jalankan evaluasi kelulusan dan alumni sekarang.
- **Ekspor data (JSON)**: unduh seluruh tabel. Kata sandi tidak ikut diekspor.
- **Impor data (JSON)**: pulihkan dari berkas backup. Data dengan ID yang sama diperbarui.

> Simpan berkas backup di tempat aman. Berkas ini berisi data pribadi anggota.

---

## 5. Model Data (Spreadsheet)

| Tabel | Isi utama |
|---|---|
| `Users` | Akun, peran (Admin/Member), username, email, hash kata sandi, bio, avatar, data reset |
| `ReadingBooks` | Buku pengguna: judul, penulis, topik, total dan halaman saat ini, sampul (URL dan ID file Drive), status |
| `ReadingLogs` | Catatan sesi: tanggal, rentang halaman, menit total dan efektif, insight, topik, privasi, kelas |
| `Comments` | Komentar pada catatan |
| `Friends` | Hubungan pertemanan |
| `Classes` | Kelas batch: jadwal, syarat lulus, status |
| `ClassMembers` | Keanggotaan kelas dan kelulusan |
| `Tasks` | 10 tugas per kelas: judul, deskripsi, tanggal aktif, form (JSON), aturan validasi (JSON) |
| `UserTasks` | Jawaban dan status peninjauan tugas per anggota (skor dan feedback) |

Nama kolom dan urutannya dibuat otomatis oleh `setupDatabase()`. Jangan mengubah nama header di spreadsheet.

---

## 6. Referensi API (untuk pengembang)

Permintaan: `POST` ke URL `/exec` dengan body teks JSON `{"action": "...", "token": "...", "data": {...}}`.
Respons: `{ "success": true|false, "message": "...", "data": {...}, "timestamp": "...", "code": "..." }`.

Sumber lengkap: fungsi `km_route_` di `code.gs`.

| Kelompok | Aksi |
|---|---|
| Umum | `health` (GET), `publicCatalog` (GET) |
| Akun | `register`, `login`, `logout`, `updateProfile`, `changePassword`, `requestPasswordReset`, `confirmPasswordReset` |
| Dashboard | `getDashboard`, `getUserBookshelf`, `getBookTimeline` |
| Buku | `saveReadingBook`, `deleteReadingBook`, `uploadBookCover`, `deleteBookCover` |
| Catatan | `saveLog`, `deleteLog`, `addComment`, `deleteComment` |
| Sosial | `toggleFriend` |
| Kelas | `listClasses`, `saveClass`, `deleteClass`, `joinClass`, `listClassMembers`, `leaderboard`, `generateClassTasks` |
| Tugas | `listTasks`, `saveTask`, `deleteTask`, `submitTask`, `listTaskSubmissions`, `reviewSubmission` |
| Admin | `listUsers`, `saveUser`, `deleteUser`, `getMemberProgress`, `impersonateUser`, `runLifecycle`, `exportAllData`, `importAllData` |

Catatan keamanan: setiap aksi selain `health` dan `publicCatalog` memerlukan token sesi. Aksi admin hanya diterima untuk peran Admin. Sesi berlaku sampai 6 jam.

---

## 7. Pemecahan Masalah

| Gejala | Penyebab umum | Solusi |
|---|---|---|
| "URL API belum diatur" | `REPLACE_WITH_DEPLOYMENT_ID` belum diganti | Ulangi bagian 3, langkah 3. |
| Pesan "Sesi berakhir" terus muncul, atau data tidak termuat | Deployment tidak dibuka untuk *Anyone*, atau dijalankan sebagai akun lain | Deploy ulang dengan pengaturan di 2.3. |
| Pesan "Gagal menyimpan sampul" dengan kode DRIVE_SHARING | Akun Apps Script tidak mendapat izin membagikan berkas Drive | Jalankan ulang `setupDatabase()` dan setujui izin Drive. |
| Sampul tidak bisa diunggah | Format bukan JPG/PNG/WebP atau lebih dari 3 MB | Kompres gambar lalu coba lagi. |
| Sampul tidak tampil | Izin Drive belum disetujui atau berkas dihapus manual | Jalankan ulang `setupDatabase()`, lalu unggah ulang sampul. |
| Login diblokir sementara | Terlalu banyak percobaan gagal | Tunggu 15 menit. |
| Kelas tidak berpindah ke alumni | Pemicu harian belum dipasang | Jalankan `kmInstallDailyTrigger()`, atau gunakan tombol di panel admin. |
| Perubahan kode tidak terasa | Deployment masih versi lama | Deploy > Manage deployments > New version. |
| Timer hilang | Timer disimpan di perangkat, dan tombol Batal membuangnya | Mulai ulang dari tombol Baca. |

---

## 8. Checklist Peluncuran

- [ ] Spreadsheet dibuat, `SPREADSHEET_ID` diisi.
- [ ] `setupDatabase()` dijalankan dan izin disetujui.
- [ ] Deployment Web App (Anyone) dibuat, URL `/exec` disalin.
- [ ] `ADMIN_EMAILS` diisi dengan email mentor.
- [ ] `kmInstallDailyTrigger()` dijalankan.
- [ ] `API_URL` di tema sudah diganti dan disimpan.
- [ ] Daftar akun pertama (menjadi Admin), lalu uji satu sesi timer dan satu unggah sampul.
- [ ] Buat kelas, jalankan **Generate tugas**, lalu uji gabung kelas dan kirim tugas.

Selamat membaca bersama!
