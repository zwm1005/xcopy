#!/usr/bin/env sh
set -eu
package_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
install_dir="${XCOPY_INSTALL_DIR:-$HOME/.local/bin}"
mkdir -p "$install_dir"
temporary=$(mktemp "$install_dir/.xcopy-install.XXXXXX")
trap 'rm -f "$temporary"' EXIT HUP INT TERM
install -m 0755 "$package_dir/xcopy" "$temporary"
mv -f "$temporary" "$install_dir/xcopy"
printf '已安装到 %s/xcopy\n' "$install_dir"
case ":$PATH:" in
  *":$install_dir:"*) ;;
  *) printf '请把目录加入 PATH，例如：export PATH="$HOME/.local/bin:$PATH"\n' ;;
esac
printf '下一步：xcopy init --name 设备名 --receive-dir ~/xcopy/inbox\n'
printf '然后：xcopy service install --user --start\n'
