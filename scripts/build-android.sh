#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."

build_type="${1:-release}"
case "$build_type" in
  release) task=assembleRelease ;;
  debug) task=assembleDebug ;;
  *) echo 'Usage: scripts/build-android.sh [release|debug]' >&2; exit 1 ;;
esac

if [[ -z "${JAVA_HOME:-}" && -d /opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home ]]; then
  export JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home
fi
export ANDROID_HOME="${ANDROID_HOME:-/opt/homebrew/share/android-commandlinetools}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export PATH="${JAVA_HOME:+$JAVA_HOME/bin:}$ANDROID_HOME/platform-tools:$PATH"

if [[ ! -f android/gradlew ]]; then
  echo 'Generate the native project first: npx expo prebuild --platform android' >&2
  exit 1
fi
if [[ "$build_type" == release && ! -f "$HOME/.config/trip/android-signing.properties" ]]; then
  echo 'Missing ~/.config/trip/android-signing.properties; see docs/android.md' >&2
  exit 1
fi

(cd android && ./gradlew ":app:$task" --max-workers=2 "${@:2}")
mkdir -p dist
apk_name="$(node -p 'const c=require("./app.json").expo; `Trip-${c.version}-${c.android.versionCode}`')"
cp "android/app/build/outputs/apk/$build_type/app-$build_type.apk" "dist/$apk_name-$build_type.apk"
printf 'APK: %s/dist/%s-%s.apk\n' "$PWD" "$apk_name" "$build_type"
