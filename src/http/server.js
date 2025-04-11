import express from "express";
import axios from "axios";
import TelegramBot from "node-telegram-bot-api";
import { MongoClient } from "mongodb";
import "dotenv/config";

// Configurações
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const MERCADOPAGO_TOKEN = process.env.MERCADOPAGO_TOKEN;
const MONGODB_URI = process.env.MONGODB_URI;
const PORT = process.env.PORT || 3000;
const RAILWAY_URL = process.env.RAILWAY_URL;
const SEU_CHAT_ID = process.env.SEU_CHAT_ID; // Seu ID pessoal do Telegram
const GRUPO_ID = process.env.GRUPO_ID; // ID do grupo no Telegram (começa com -100 para supergrupos)

// Inicialização
const app = express();
const bot = new TelegramBot(TELEGRAM_TOKEN);
let db;

// Objeto para armazenar formulários em andamento
const formulariosPendentes = new Map();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.disable("x-powered-by");

// Conexão com MongoDB
async function connectDB() {
  const client = new MongoClient(MONGODB_URI, {
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 10000,
  });

  try {
    await client.connect();
    db = client.db("telegram_bot");
    await db.command({ ping: 1 });
    console.log("Conectado ao MongoDB com sucesso!");
  } catch (err) {
    console.error("Falha na conexão com MongoDB:", err);
    process.exit(1);
  }
}

// Configurar Webhook do Telegram
async function setupWebhook() {
  try {
    await bot.setWebHook(`${RAILWAY_URL}/telegram-webhook`);
    console.log("Webhook configurado com sucesso!");
  } catch (err) {
    console.error("Erro ao configurar webhook:", err);
  }
}

// Funções auxiliares
async function verificarAssinatura(userId) {
  try {
    const user = await db.collection("users").findOne({ user_id: userId });
    return user && user.status === "active";
  } catch (err) {
    console.error("Erro ao verificar assinatura:", err);
    return false;
  }
}

async function criarLinkPagamento(userId, dadosFormulario) {
  try {
    const response = await axios.post(
      "https://api.mercadopago.com/checkout/preferences",
      {
        items: [
          {
            title: "Assinatura Mensal",
            quantity: 1,
            unit_price: 29.9,
            currency_id: "BRL",
          },
        ],
        back_urls: {
          success: `${RAILWAY_URL}/sucesso`,
          failure: `${RAILWAY_URL}/erro`,
          pending: `${RAILWAY_URL}/pendente`,
        },
        notification_url: `${RAILWAY_URL}/mp-webhook`,
        metadata: {
          telegram_user_id: userId,
          nome: dadosFormulario.nome,
          email: dadosFormulario.email,
        },
      },
      {
        headers: {
          Authorization: `Bearer ${MERCADOPAGO_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );

    return response.data.init_point || response.data.sandbox_init_point;
  } catch (error) {
    console.error("Erro ao criar link de pagamento:", error);
    return `${RAILWAY_URL}/assinatura`;
  }
}

// Função para enviar formulário
async function enviarFormulario(chatId) {
  return new Promise(async (resolve) => {
    // Armazena o estado do formulário
    const formulario = {
      etapa: 1,
      dados: {},
    };
    formulariosPendentes.set(chatId, formulario);

    // Envia a primeira pergunta
    await bot.sendMessage(
      chatId,
      "📝 Antes de gerar o link de pagamento, precisamos de algumas informações:"
    );
    await bot.sendMessage(chatId, "1. Qual seu nome completo?");

    // Configura um listener temporário para as respostas
    const listenerId = bot.on("message", async (msg) => {
      if (msg.chat.id !== chatId || msg.text.startsWith("/")) return;

      const formularioAtual = formulariosPendentes.get(chatId);

      try {
        switch (formularioAtual.etapa) {
          case 1: // Nome
            formularioAtual.dados.nome = msg.text;
            formularioAtual.etapa = 2;
            await bot.sendMessage(chatId, "2. Qual seu e-mail?");
            break;

          case 2: // Email
            if (!msg.text.includes("@")) {
              await bot.sendMessage(
                chatId,
                "❌ Por favor, digite um e-mail válido:"
              );
              return;
            }
            formularioAtual.dados.email = msg.text;
            formularioAtual.etapa = 3;
            await bot.sendMessage(chatId, "3. Qual seu telefone com DDD?");
            break;

          case 3: // Telefone
            formularioAtual.dados.telefone = msg.text;

            // Envia os dados para você
            await bot.sendMessage(
              SEU_CHAT_ID,
              `📋 Novo formulário preenchido!\n\n` +
                `👤 Nome: ${formularioAtual.dados.nome}\n` +
                `📧 Email: ${formularioAtual.dados.email}\n` +
                `📞 Telefone: ${formularioAtual.dados.telefone}\n` +
                `🆔 ID do Usuário: ${chatId}`
            );

            // Salva no banco de dados
            await db.collection("formularios").insertOne({
              user_id: chatId,
              ...formularioAtual.dados,
              data_preenchimento: new Date(),
            });

            // Finaliza o formulário
            formulariosPendentes.delete(chatId);
            bot.removeListener("message", listenerId);
            resolve(formularioAtual.dados);
            break;
        }
      } catch (error) {
        console.error("Erro no formulário:", error);
        bot.removeListener("message", listenerId);
        formulariosPendentes.delete(chatId);
        throw error;
      }
    });
  });
}

// Rotas
app.post("/telegram-webhook", (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

app.post("/mp-webhook", async (req, res) => {
  try {
    const paymentId = req.body.data?.id;

    if (!paymentId) {
      return res.status(400).json({ error: "ID de pagamento ausente" });
    }

    const response = await axios.get(
      `https://api.mercadopago.com/v1/payments/${paymentId}`,
      {
        headers: {
          Authorization: `Bearer ${MERCADOPAGO_TOKEN}`,
        },
      }
    );

    const { metadata, status } = response.data;
    const userId = metadata?.telegram_user_id;

    if (userId && status === "approved") {
      // Atualiza o banco de dados
      await db.collection("users").updateOne(
        { user_id: userId },
        {
          $set: {
            mp_subscription_id: paymentId,
            status: "active",
            updated_at: new Date(),
          },
          $setOnInsert: {
            created_at: new Date(),
          },
        },
        { upsert: true }
      );

      // Notifica o usuário
      await bot.sendMessage(
        userId,
        "🎉 Pagamento aprovado! Você será adicionado ao grupo em instantes."
      );

      // Adiciona ao grupo e concede privilégios
      try {
        await bot.sendMessage(
          GRUPO_ID,
          `👋 Bem-vindo ${metadata.nome || "novo membro"} ao grupo!`
        );

        await bot.addChatMember(GRUPO_ID, userId);
        await bot.sendMessage(
          SEU_CHAT_ID,
          `✅ Usuário ${userId} (${
            metadata.nome || "sem nome"
          }) adicionado ao grupo automaticamente.`
        );
      } catch (error) {
        console.error("Erro ao adicionar ao grupo:", error);
        await bot.sendMessage(
          SEU_CHAT_ID,
          `⚠️ Falha ao adicionar usuário ${userId} ao grupo. Erro: ${error.message}`
        );
      }
    }

    res.status(200).json({ status: "ok" });
  } catch (error) {
    console.error("Erro no webhook:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Handlers do Telegram
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;

  try {
    const isAssinante = await verificarAssinatura(chatId);

    if (isAssinante) {
      await bot.sendMessage(
        chatId,
        "✅ Você já é um assinante ativo! Acesso liberado."
      );
      return;
    }

    // Inicia o fluxo do formulário
    await bot.sendMessage(
      chatId,
      "Vamos precisar de algumas informações antes de gerar seu link de pagamento..."
    );

    const dadosFormulario = await enviarFormulario(chatId);

    // Gera e envia o link de pagamento
    const linkPagamento = await criarLinkPagamento(chatId, dadosFormulario);

    await bot.sendMessage(
      chatId,
      `🔗 Aqui está seu link de pagamento exclusivo:\n${linkPagamento}\n\n` +
        `Após o pagamento aprovado, você será adicionado automaticamente ao grupo.`
    );
  } catch (error) {
    console.error("Erro no comando /start:", error);
    await bot.sendMessage(
      chatId,
      "⚠️ Ocorreu um erro no processo. Por favor, comece novamente com /start."
    );
  }
});

// Comando para administradores verificarem dados
bot.onText(/\/dados (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;

  // Verifica se é o administrador
  if (chatId.toString() !== SEU_CHAT_ID) {
    await bot.sendMessage(chatId, "❌ Acesso negado.");
    return;
  }

  const userId = match[1];

  try {
    const [usuario, formulario] = await Promise.all([
      db.collection("users").findOne({ user_id: parseInt(userId) }),
      db.collection("formularios").findOne({ user_id: parseInt(userId) }),
    ]);

    let resposta = `📊 Dados do usuário ${userId}:\n\n`;

    if (formulario) {
      resposta +=
        `📝 Formulário:\n` +
        `Nome: ${formulario.nome}\n` +
        `Email: ${formulario.email}\n` +
        `Telefone: ${formulario.telefone}\n` +
        `Data: ${formulario.data_preenchimento}\n\n`;
    }

    if (usuario) {
      resposta +=
        `💳 Assinatura:\n` +
        `Status: ${usuario.status}\n` +
        `ID Pagamento: ${usuario.mp_subscription_id}\n` +
        `Última atualização: ${usuario.updated_at}`;
    }

    await bot.sendMessage(chatId, resposta);
  } catch (error) {
    console.error("Erro ao buscar dados:", error);
    await bot.sendMessage(chatId, "❌ Erro ao buscar dados do usuário.");
  }
});

// Health Check
app.get("/", (req, res) => {
  res.status(200).json({
    status: "online",
    timestamp: new Date(),
    formularios_ativos: formulariosPendentes.size,
  });
});

// Inicialização
async function startServer() {
  try {
    // Verifica variáveis essenciais
    if (
      !TELEGRAM_TOKEN ||
      !MERCADOPAGO_TOKEN ||
      !MONGODB_URI ||
      !SEU_CHAT_ID ||
      !GRUPO_ID
    ) {
      throw new Error("Variáveis de ambiente essenciais faltando!");
    }

    await connectDB();
    await setupWebhook();

    app.listen(PORT, () => {
      console.log(`🚀 Servidor rodando na porta ${PORT}`);
      console.log(`🔗 Webhook: ${RAILWAY_URL}/telegram-webhook`);
      console.log(`🔗 MercadoPago Webhook: ${RAILWAY_URL}/mp-webhook`);
      console.log(`👤 Seu CHAT_ID: ${SEU_CHAT_ID}`);
      console.log(`👥 GRUPO_ID: ${GRUPO_ID}`);
    });
  } catch (err) {
    console.error("Falha na inicialização:", err);
    process.exit(1);
  }
}

startServer();
