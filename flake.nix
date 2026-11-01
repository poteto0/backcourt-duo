{
  description = "backcourt-duo — local agent-paired code review kit";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAll = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in {
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
