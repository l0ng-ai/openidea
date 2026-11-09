#!/usr/bin/env bash
# Fetch the real Laravel applications that Plan 8's real-application checks and benches run on
# (`LARAVEL_APP_DIR`) into ${PHP_CORPUS_DIR:-../php-corpus}/apps, with their vendor/.
#
# The apps are never run: dependencies are installed with --no-scripts --no-plugins, so no
# code from the apps or their packages executes. Composer needs PHP; without one on PATH the
# script downloads a portable PHP and composer.phar into ${PHP_CORPUS_DIR}/tools (checked
# against their published SHA-256 sums). Nothing is installed system-wide.
#   scripts/laravel-apps.sh          fetch what is missing
#   scripts/laravel-apps.sh --check  only verify, exit 1 if anything is missing
set -euo pipefail

cd "$(dirname "$0")/.."
DIR=${PHP_CORPUS_DIR:-../php-corpus}
APPS="$DIR/apps"
TOOLS="$DIR/tools"
PHP_ZIP=php-8.4.27-1-nts-Win32-vs17-x64.zip

# name  repository  pinned commit
LARAVEL_APPS=(
    "monica https://github.com/monicahq/monica.git dab74273acc5c9e0ba713a9f7c2c71c24ab16993"
    "bagisto https://github.com/bagisto/bagisto.git b740b83719bd698c93a07c4bc1c1f21f2cc169f1"
)

check=0
case "${1:-}" in
    --check) check=1 ;;
    "") ;;
    *)
        echo "usage: $0 [--check]" >&2
        exit 2
        ;;
esac

php_cmd() {
    if command -v php >/dev/null && command -v composer >/dev/null; then
        echo "composer"
        return
    fi
    if [[ ! -x "$TOOLS/php/php.exe" ]]; then
        mkdir -p "$TOOLS"
        (
            cd "$TOOLS"
            curl -fsSLo php.zip "https://downloads.php.net/~windows/releases/$PHP_ZIP"
            curl -fsSLo sha256sum.txt https://downloads.php.net/~windows/releases/sha256sum.txt
            [[ "$(grep -i "$PHP_ZIP" sha256sum.txt | awk '{print $1}')" == "$(sha256sum php.zip | awk '{print $1}')" ]] ||
                { echo "php.zip checksum mismatch" >&2; exit 1; }
            unzip -qo php.zip -d php
            curl -fsSLo composer.phar https://getcomposer.org/download/latest-stable/composer.phar
            curl -fsSLo composer.sha256 https://getcomposer.org/download/latest-stable/composer.phar.sha256
            [[ "$(awk '{print $1}' composer.sha256)" == "$(sha256sum composer.phar | awk '{print $1}')" ]] ||
                { echo "composer.phar checksum mismatch" >&2; exit 1; }
        )
    fi
    local ext="$TOOLS/php/ext"
    echo "$TOOLS/php/php.exe -d extension_dir=$ext -d extension=openssl -d extension=mbstring -d extension=zip -d extension=curl -d extension=fileinfo -d memory_limit=-1 $TOOLS/composer.phar"
}

status=0
for entry in "${LARAVEL_APPS[@]}"; do
    read -r name url commit <<<"$entry"
    dest="$APPS/$name"
    if [[ -d "$dest/.git" && -d "$dest/vendor" ]]; then
        have=$(git -C "$dest" rev-parse HEAD)
        if [[ "$have" == "$commit" ]]; then
            echo "$name: ok ($commit)"
        else
            echo "$name: at $have, expected $commit (delete it to re-fetch)" >&2
            status=1
        fi
        continue
    fi
    if ((check)); then
        echo "$name: missing" >&2
        status=1
        continue
    fi
    if [[ ! -d "$dest/.git" ]]; then
        mkdir -p "$dest"
        git -C "$dest" init -q
        git -C "$dest" remote add origin "$url"
        git -C "$dest" fetch -q --depth 1 origin "$commit"
        git -C "$dest" -c advice.detachedHead=false checkout -q FETCH_HEAD
    fi
    composer=$(php_cmd)
    (cd "$dest" && $composer install --no-scripts --no-plugins --ignore-platform-reqs --prefer-dist --no-interaction --no-progress)
    echo "$name: fetched ($commit)"
done
exit $status
