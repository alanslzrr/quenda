import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import tls from "node:tls";
import { promisify } from "node:util";
import { createMailTransport } from "../../src/mail/transport.ts";

test("SMTP validates TLS certificates, authenticates and rejects plaintext downgrade", {
  timeout: 30000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "quenda-smtp-"));
  const keyPath = join(root, "key.pem"),
    certPath = join(root, "cert.pem");
  const sockets = new Set<net.Socket>();
  const received: string[] = [];
  let authenticated = false,
    recipients = 0;
  let upgradeContext: tls.SecureContext | undefined;
  const handle = (socket: net.Socket, greeting = true) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.setEncoding("utf8");
    if (greeting) socket.write("220 localhost ESMTP\r\n");
    let buffer = "",
      data = false,
      message = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      while (buffer.includes("\r\n")) {
        const index = buffer.indexOf("\r\n"),
          line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (data) {
          if (line === ".") {
            received.push(message);
            message = "";
            data = false;
            socket.write("250 Accepted\r\n");
          } else message += `${line}\n`;
        } else if (line.startsWith("EHLO"))
          socket.write("250-localhost\r\n250 AUTH PLAIN\r\n");
        else if (line.startsWith("AUTH PLAIN ")) {
          assert.ok(socket instanceof tls.TLSSocket);
          authenticated =
            Buffer.from(line.slice(11), "base64").toString() ===
            "\0fixture-user\0fixture-password";
          socket.write(
            authenticated ? "235 Authenticated\r\n" : "535 Rejected\r\n",
          );
        } else if (line.startsWith("MAIL FROM:"))
          socket.write(
            authenticated ? "250 OK\r\n" : "530 Authentication required\r\n",
          );
        else if (line.startsWith("RCPT TO:")) {
          recipients++;
          socket.write(
            line.includes("reject@example.test")
              ? "550 Rejected\r\n"
              : "250 OK\r\n",
          );
        } else if (line === "DATA") {
          data = true;
          socket.write("354 Continue\r\n");
        } else if (line === "STARTTLS" && upgradeContext) {
          socket.write("220 Upgrade\r\n");
          socket.removeAllListeners("data");
          handle(
            new tls.TLSSocket(socket, {
              isServer: true,
              secureContext: upgradeContext,
            }),
            false,
          );
          return;
        } else if (line === "QUIT") socket.end("221 Bye\r\n");
        else socket.write("502 Unsupported\r\n");
      }
    });
  };
  let secure: tls.Server | undefined, plain: net.Server | undefined;
  try {
    await promisify(execFile)("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost",
    ]);
    secure = tls.createServer(
      { key: await readFile(keyPath), cert: await readFile(certPath) },
      handle,
    );
    secure.on("tlsClientError", () => {});
    await new Promise<void>((resolve) =>
      secure?.listen(0, "127.0.0.1", resolve),
    );
    const port = (secure.address() as net.AddressInfo).port;
    const config = {
      kind: "smtp" as const,
      host: "127.0.0.1",
      port,
      secure: true,
      servername: "localhost",
      from: "quenda@example.test",
      user: "fixture-user",
      password: "fixture-password",
    };
    const message = {
      to: "citizen@example.test",
      subject: "Synthetic message",
      text: "Local SMTP fixture",
    };
    await assert.rejects(createMailTransport(config).send(message), {
      message: "Mail transport unavailable",
    });
    assert.equal(received.length, 0);
    const transport = createMailTransport({ ...config, caFile: certPath });
    await transport.send(message);
    assert.equal(authenticated, true);
    assert.equal(received.length, 1);
    assert.match(received[0] as string, /Local SMTP fixture/);
    await assert.rejects(
      transport.send({ ...message, to: "reject@example.test" }),
      { message: "Mail transport unavailable" },
    );
    assert.equal(received.length, 1);
    await assert.rejects(
      createMailTransport({
        ...config,
        caFile: certPath,
        servername: "wrong.test",
      }).send(message),
      { message: "Mail transport unavailable" },
    );
    plain = net.createServer(handle);
    await new Promise<void>((resolve) =>
      plain?.listen(0, "127.0.0.1", resolve),
    );
    const priorRecipients = recipients;
    await assert.rejects(
      createMailTransport({
        ...config,
        secure: false,
        port: (plain.address() as net.AddressInfo).port,
      }).send(message),
      { message: "Mail transport unavailable" },
    );
    assert.equal(recipients, priorRecipients);
    assert.equal(received.length, 1);
    upgradeContext = tls.createSecureContext({
      key: await readFile(keyPath),
      cert: await readFile(certPath),
    });
    await createMailTransport({
      ...config,
      secure: false,
      port: (plain.address() as net.AddressInfo).port,
      caFile: certPath,
    }).send(message);
    assert.equal(received.length, 2);
  } finally {
    for (const socket of sockets) socket.destroy();
    await Promise.all(
      [secure, plain]
        .filter(Boolean)
        .map(
          (server) =>
            new Promise<void>((resolve) => server?.close(() => resolve())),
        ),
    );
    await rm(root, { recursive: true, force: true });
  }
});
