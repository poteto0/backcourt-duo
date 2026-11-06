{
  description = "backcourt-duo — local agent-paired code review kit";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAll = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in {
      # `nix run` / `nix profile install` で使うパッケージ。
      # 実行時の node は Nix の nodejs_26 に固定されるので、どのリポジトリで起動しても
      # ユーザー環境の node（PATH 上のもの）には影響されない。
      packages = forAll (pkgs:
        let
          nodejs = pkgs.nodejs_26;
          pnpm = pkgs.pnpm;
          backcourt-duo = pkgs.stdenv.mkDerivation (finalAttrs: {
            pname = "backcourt-duo";
            version = (builtins.fromJSON (builtins.readFile ./package.json)).version;
            src = self;

            nativeBuildInputs = [ nodejs pnpm pkgs.pnpmConfigHook pkgs.makeWrapper ];

            pnpmDeps = pkgs.fetchPnpmDeps {
              inherit (finalAttrs) pname version src;
              inherit pnpm;
              fetcherVersion = 5;
              hash = "sha256-FpymE+a+WX+hL5UQ4dc3PWE14y7bjsSruNrAi/VNnSk=";
            };

            buildPhase = ''
              runHook preBuild
              pnpm build
              runHook postBuild
            '';

            installPhase = ''
              runHook preInstall
              # 本番依存だけを入れ直す（prune はネットワークに出ようとするので使わない）
              rm -rf node_modules
              pnpm_config_trust_lockfile=true pnpm install --offline --prod --frozen-lockfile --ignore-scripts
              mkdir -p $out/lib/backcourt-duo $out/bin
              cp -r package.json bin dist node_modules $out/lib/backcourt-duo/
              for name in backcourt-duo backcort-duo; do
                makeWrapper ${nodejs}/bin/node $out/bin/$name \
                  --add-flags $out/lib/backcourt-duo/bin/backcourt-duo.js
              done
              runHook postInstall
            '';

            meta.mainProgram = "backcourt-duo";
          });
        in {
          inherit backcourt-duo;
          default = backcourt-duo;
        });

      devShells = forAll (pkgs: {
        default = pkgs.mkShell {
          packages = [
            pkgs.nodejs_26
            pkgs.pnpm
            pkgs.git
            pkgs.gh
          ];
          shellHook = ''
            echo "backcourt-duo devshell: node $(node -v), pnpm $(pnpm -v)"
          '';
        };
      });
    };
}
