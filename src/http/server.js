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
const SEU_CHAT_ID = process.env.SEU_CHAT_ID;
const GRUPO_ID = process.env.GRUPO_ID;
const SEU_WHATSAPP = process.env.ZAP;

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
    const webhookUrl = `${RAILWAY_URL}/telegram-webhook`;
    console.log(`Configurando webhook para: ${webhookUrl}`);
    await bot.setWebHook(webhookUrl);
    console.log("Webhook configurado com sucesso!");
  } catch (err) {
    console.error("Erro ao configurar webhook:", err);
    throw err;
  }
}

// Função para gerar link do WhatsApp
async function enviarParaWhatsApp(dados) {
  try {
    const mensagem =
      `✅ NOVO ASSINANTE\n\n` +
      `Nome: ${dados.nome}\n` +
      `Email: ${dados.email}\n` +
      `Telefone: ${dados.telefone}\n` +
      `ID Telegram: ${dados.userId}\n` +
      `ID Pagamento: ${dados.paymentId || "N/A"}`;

    const linkWhatsApp = `https://wa.me/${SEU_WHATSAPP}?text=${encodeURIComponent(
      mensagem
    )}`;

    console.log("🔗 Link WhatsApp:", linkWhatsApp);
    await bot.sendMessage(
      SEU_CHAT_ID,
      `📤 Clique para enviar dados ao WhatsApp:\n${linkWhatsApp}`
    );

    return true;
  } catch (error) {
    console.error("Erro ao gerar link WhatsApp:", error);
    return false;
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
          telefone: dadosFormulario.telefone,
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
    throw error;
  }
}

// Função para enviar formulário
async function enviarFormulario(chatId) {
  return new Promise(async (resolve, reject) => {
    if (formulariosPendentes.has(chatId)) {
      await bot.sendMessage(
        chatId,
        "ℹ️ Você já tem um formulário em andamento."
      );
      return reject(new Error("Formulário já em andamento"));
    }

    const formulario = {
      etapa: 1,
      dados: {},
      listener: null,
    };

    formulariosPendentes.set(chatId, formulario);

    const timeout = setTimeout(() => {
      if (formulario.listener) {
        bot.removeListener("message", formulario.listener);
      }
      formulariosPendentes.delete(chatId);
      bot.sendMessage(chatId, "⌛ Tempo expirado. Use /start para recomeçar.");
      reject(new Error("Tempo expirado"));
    }, 600000);

    formulario.listener = async (msg) => {
      if (msg.chat.id !== chatId || msg.text.startsWith("/")) return;

      try {
        const formularioAtual = formulariosPendentes.get(chatId);
        if (!formularioAtual) return;

        switch (formularioAtual.etapa) {
          case 1:
            formularioAtual.dados.nome = msg.text;
            formularioAtual.etapa = 2;
            await bot.sendMessage(chatId, "2. Qual seu e-mail?");
            break;

          case 2:
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

          case 3:
            formularioAtual.dados.telefone = msg.text;

            await db.collection("formularios").insertOne({
              user_id: chatId,
              ...formularioAtual.dados,
              data_preenchimento: new Date(),
            });

            clearTimeout(timeout);
            bot.removeListener("message", formularioAtual.listener);
            formulariosPendentes.delete(chatId);
            resolve(formularioAtual.dados);
            break;
        }
      } catch (error) {
        clearTimeout(timeout);
        if (formulario.listener) {
          bot.removeListener("message", formulario.listener);
        }
        formulariosPendentes.delete(chatId);
        reject(error);
      }
    };

    bot.on("message", formulario.listener);

    try {
      await bot.sendMessage(chatId, "📝 Precisamos de algumas informações:");
      await bot.sendMessage(chatId, "1. Qual seu nome completo?");
    } catch (error) {
      clearTimeout(timeout);
      if (formulario.listener) {
        bot.removeListener("message", formulario.listener);
      }
      formulariosPendentes.delete(chatId);
      reject(error);
    }
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

    console.log(`Processando pagamento ${paymentId}`);

    const response = await axios.get(
      `https://api.mercadopago.com/v1/payments/${paymentId}`,
      { headers: { Authorization: `Bearer ${MERCADOPAGO_TOKEN}` } }
    );

    const { metadata, status } = response.data;
    const userId = metadata?.telegram_user_id;

    if (userId && status === "approved") {
      console.log(`Pagamento aprovado para usuário ${userId}`);

      // 1. Atualiza o banco de dados
      await db.collection("users").updateOne(
        { user_id: userId },
        {
          $set: {
            mp_subscription_id: paymentId,
            status: "active",
            updated_at: new Date(),
            nome: metadata.nome,
            email: metadata.email,
            telefone: metadata.telefone,
          },
          $setOnInsert: {
            created_at: new Date(),
          },
        },
        { upsert: true }
      );

      // 2. Envia para o WhatsApp
      await enviarParaWhatsApp({
        nome: metadata.nome,
        email: metadata.email,
        telefone: metadata.telefone,
        userId: userId,
        paymentId: paymentId,
      });

      // 3. Notifica o usuário
      await bot.sendMessage(
        userId,
        "🎉 Pagamento aprovado! Você será adicionado ao grupo em instantes."
      );

      // 4. Tenta adicionar ao grupo
      try {
        console.log(
          `Tentando adicionar usuário ${userId} ao grupo ${GRUPO_ID}`
        );

        // Primeiro tenta adicionar diretamente
        await bot.addChatMember(GRUPO_ID, userId);

        // Mensagem de boas-vindas no grupo
        await bot.sendMessage(
          GRUPO_ID,
          `👋 Bem-vindo ${metadata.nome || "novo membro"} ao grupo!`
        );

        // Mensagem para o usuário
        await bot.sendMessage(
          userId,
          `✅ Você foi adicionado ao grupo com sucesso!`
        );
      } catch (error) {
        console.error("Erro ao adicionar ao grupo:", error);

        // Se falhar, cria um link de convite único
        const inviteLink = await bot.createChatInviteLink(GRUPO_ID, {
          member_limit: 1,
          name: `Convite para ${metadata.nome || userId}`,
          creates_join_request: false,
        });

        await bot.sendMessage(
          userId,
          `🔗 Clique neste link para entrar no grupo:\n${inviteLink.invite_link}\n\n` +
            `Este link é válido apenas para você e expira após 1 uso.`
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

    try {
      await bot.sendMessage(
        chatId,
        "Vamos precisar de algumas informações antes de gerar seu link de pagamento..."
      );

      const dadosFormulario = await enviarFormulario(chatId);
      const linkPagamento = await criarLinkPagamento(chatId, dadosFormulario);

      await bot.sendMessage(
        chatId,
        `🔗 Aqui está seu link de pagamento:\n${linkPagamento}\n\n` +
          `Após o pagamento, você será adicionado automaticamente ao grupo.`
      );
    } catch (error) {
      console.error("Erro no formulário:", error);
      await bot.sendMessage(
        chatId,
        "⚠️ Ocorreu um erro. Por favor, comece novamente com /start."
      );
    }
  } catch (error) {
    console.error("Erro no comando /start:", error);
    await bot.sendMessage(
      chatId,
      "⚠️ Ocorreu um erro. Tente novamente mais tarde."
    );
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
    console.log("Iniciando servidor...");

    if (
      !TELEGRAM_TOKEN ||
      !MERCADOPAGO_TOKEN ||
      !MONGODB_URI ||
      !SEU_CHAT_ID ||
      !GRUPO_ID
    ) {
      throw new Error("Variáveis de ambiente faltando!");
    }

    await connectDB();
    await setupWebhook();

    app.listen(PORT, () => {
      console.log(`🚀 Servidor rodando na porta ${PORT}`);
      console.log(`🔗 Webhook: ${RAILWAY_URL}/telegram-webhook`);
      console.log(`🔗 MercadoPago Webhook: ${RAILWAY_URL}/mp-webhook`);
    });
  } catch (err) {
    console.error("Falha na inicialização:", err);
    process.exit(1);
  }
}

startServer();
