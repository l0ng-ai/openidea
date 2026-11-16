<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="src-tauri/icons/source/openidea-wordmark-dark.svg">
    <img src="src-tauri/icons/source/openidea-wordmark.svg" alt="OpenIDEA" height="56">
  </picture>
</p>

<p align="center">
  Bildiğin IDE, Rust ile yeniden yazıldı.
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · Türkçe
</p>

<p align="center">
  <a href="https://github.com/l0ng-ai/openidea/releases/latest"><b>İndir</b></a>
  &nbsp;·&nbsp;
  <a href="https://openidea.sh">Belgeler</a>
  &nbsp;·&nbsp;
  <a href="#performans-karşılaştırması">Performans</a>
  &nbsp;·&nbsp;
  <a href="#eklentiler">Eklentiler</a>
  &nbsp;·&nbsp;
  <a href="#topluluk">Topluluk</a>
</p>

https://github.com/user-attachments/assets/234dd54c-1255-4b3a-b35c-533d78d737c0

OpenIDEA, IntelliJ IDEA'nın çalışma biçimini (kısayol tuşlarını, araç pencerelerini,
her şeyi arama alışkanlığını) çekirdeği Rust ile yazılmış yerel bir uygulamaya taşır.

Editör, kod analizi, hata ayıklayıcı (debugger), Git, terminal, veritabanı ve HTTP istemcileri;
60'tan fazla dil için. macOS, Windows ve Linux sürümleri var.

## Performans karşılaştırması

[freqtrade](https://github.com/freqtrade/freqtrade) projesini (Python, ~770 dosya)
önbellekler hazırken açma, 5 çalıştırmanın ortancası:

|                              | OpenIDEA                | IntelliJ IDEA 2026.2.3 |
| ---------------------------- | ----------------------- | ---------------------- |
| Projeyle pencerenin açılması | **0,9 sn**              | 3,1 sn                 |
| Hazır (CPU sakinleşti)       | **1,1 sn**              | 13,2 sn                |
| Bellek (USS, tüm işlemler)   | **169 MB**              | 2011 MB                |
| Hazır olana kadar CPU süresi | **2,4 sn**              | 47,9 sn                |
| Boştayken CPU                | Bir çekirdeğin **%4**'ü | Bir çekirdeğin %7'si   |
| Kapanma                      | **0,3 sn**              | 5,9 sn                 |

`main` dalından derlenmiş bir OpenIDEA sürümü ve varsayılan ayar ve eklentilerle IDEA;
Windows 11, 32 çekirdekli AMD, 62 GB RAM.
IDEA, Python'u daha derinlemesine analiz eder; yani "hazır" iki tarafta aynı işi ifade etmez.
İkisi de dışarıdan, aynı yöntemle ölçüldü: kendi makinende ve projelerinde denemek için
[`perf/compare`](perf/compare) klasörüne bak.

## Eklentiler

Eklentiler; eylemler, kod tamamlama, hızlı düzeltmeler, araç pencereleri, özel editörler,
temalar, dosya simgeleri ve diller ekler. Korumalı (sandbox) WebAssembly bileşenleri olarak çalışırlar;
temalar, simge temaları ve diller için hiç kod yazmak gerekmez.

Eklentileri Ayarlar › Eklentiler (Settings › Plugins) bölümünden kur ya da
`openidea-plugin new` ile kendininkini başlat. Ayrıntılar için [OpenIDEA eklentisi yazmak](https://openidea.sh/en/plugins) sayfasına ve
[resmi eklentilere](plugins/official) bak. Eklenti API'si hâlâ önizleme aşamasında.

## Topluluk

- [Discord](https://discord.gg/2Zy4yn7gP): sorular, geri bildirim ve sürüm haberleri.
- WeChat grubu, katılmak için kodu okut:

  <img src=".github/assets/wechat-group.png" alt="WeChat grubu QR kodu" width="200">

- Katkıda bulunmak için: [CONTRIBUTING.md](CONTRIBUTING.md) ve [katkıcı belgeleri](https://openidea.sh/en/contribute/setup).

## Lisans

[Apache 2.0](LICENSE). Pakete dahil üçüncü taraf varlıklar [`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md) dosyasında listelenir.

<sub>JetBrains ile bağlantılı değildir. IntelliJ IDEA, JetBrains s.r.o.'nun ticari markasıdır.</sub>
