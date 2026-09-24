import { useState, FormEvent } from "react";
import { Link } from "@tanstack/react-router";
import { RpcStub } from "capnweb";
import { PublicApi } from "@gadgets/workshop-shared/api";
import { hashPassword } from "./passwordHash";
import { useServerConfig, useServerConfigError, useSiteName } from "./ServerConfigContext";
import { useDocumentTitle } from "./useDocumentTitle";
import OAuthButtons from "./components/auth/OAuthButtons";
import { useConnectionLost } from "./RpcContext";
import AuthLayout, { AuthLead, AuthTitle } from "./components/brand/AuthLayout";
import { AuthConfigState, AuthError, AuthNotice, OrDivider } from "./components/brand/AuthParts";
import { BlockButton, FieldCell } from "./components/brand/BrandControls";

interface SignupPageProps {
  rpcStub: RpcStub<PublicApi>;
}

export default function SignupPage({ rpcStub }: SignupPageProps) {
  const serverConfig = useServerConfig();
  const serverConfigError = useServerConfigError();
  const siteName = useSiteName();
  const connectionLost = useConnectionLost();
  useDocumentTitle("Criar conta");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const usernameError =
    username && !/^[a-z0-9_-]+$/i.test(username)
      ? "Só letras, números, _ e -"
      : undefined;

  const passwordError =
    password && password.length < 8
      ? "Mínimo de 8 caracteres"
      : undefined;

  const confirmError =
    confirmPassword && confirmPassword !== password
      ? "As senhas não coincidem"
      : undefined;

  const canSubmit =
    username &&
    password &&
    confirmPassword &&
    !usernameError &&
    !passwordError &&
    !confirmError &&
    !loading;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setLoading(true);
    setError(null);

    try {
      const passwordHash = await hashPassword(username, password);
      const token = await rpcStub.createAccount(
        username,
        username,
        passwordHash,
      );
      if (token) {
        localStorage.setItem("authToken", token);
        window.location.href = "/";
      } else {
        setError("Esse usuário já existe");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não foi possível criar a conta");
    } finally {
      setLoading(false);
    }
  };

  if (!serverConfig) {
    return (
      <AuthLayout mode="signup">
        <AuthConfigState failed={Boolean(serverConfigError) && !connectionLost} connectionLost={connectionLost} />
      </AuthLayout>
    );
  }

  const authVendors = serverConfig.authVendors ?? [];
  const signupsEnabled = serverConfig.signupsEnabled;
  // The password create-account form requires both password auth AND open signups.
  const passwordAuthEnabled = serverConfig.passwordAuthEnabled && signupsEnabled;

  return (
    <AuthLayout mode="signup">
      <AuthTitle>
        Abra o seu
        <br />
        espaço.
      </AuthTitle>
      <AuthLead>
        Crie sua conta no {siteName} e comece a trabalhar com agentes que conhecem o seu contexto.
      </AuthLead>

      <div className="mt-auto w-full max-w-[560px] pt-12">
        {!signupsEnabled && (
          <div className="mb-6">
            <AuthNotice title="Cadastros fechados">
              A criação de novas contas está desativada neste ambiente.
            </AuthNotice>
          </div>
        )}

        {passwordAuthEnabled && (
          <form onSubmit={handleSubmit}>
            <FieldCell
              label="Usuário"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoFocus
              autoComplete="username"
              disabled={loading}
              placeholder="seu-usuario"
              hint={usernameError}
            />
            <FieldCell
              type="password"
              label="Senha"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              disabled={loading}
              placeholder="••••••••"
              hint={passwordError}
            />
            <FieldCell
              type="password"
              label="Confirmar senha"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              autoComplete="new-password"
              disabled={loading}
              placeholder="••••••••"
              hint={confirmError}
            />

            {error && <AuthError>{error}</AuthError>}

            <BlockButton type="submit" disabled={!canSubmit} loading={loading} className="mt-4">
              Criar conta
            </BlockButton>
          </form>
        )}

        {/* Gatekeeper sign-in options, shown whenever any auth vendor is configured. */}
        {authVendors.length > 0 && (
          <div className={passwordAuthEnabled ? "mt-8" : ""}>
            {passwordAuthEnabled && <OrDivider />}
            <OAuthButtons rpcStub={rpcStub} vendors={authVendors} />
          </div>
        )}

        {passwordAuthEnabled && (
          <p className="mt-5 text-[15px] tracking-[-0.01em] text-lume-muted">
            Já tem conta?{" "}
            <Link to="/" className="text-lume-ink underline decoration-lume-brand decoration-2 underline-offset-4 hover:text-lume-brand-ink">
              Entrar
            </Link>
          </p>
        )}
      </div>
    </AuthLayout>
  );
}
