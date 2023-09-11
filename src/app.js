const express = require("express");
const bodyParser = require("body-parser");
const { sequelize, Contract } = require("./model");
const { getProfile } = require("./middleware/getProfile");
const Sequelize = require("sequelize");
const moment = require("moment");
const Op = Sequelize.Op;
const app = express();

app.use(bodyParser.json());
app.set("sequelize", sequelize);
app.set("models", sequelize.models);

const StatusEnum = {
  TERMINATED: "terminated",
  IN_PROGRESS: "in_progress",
  NEW: "new",
};

app.get("/contracts/:id", getProfile, async (req, res) => {
  const { Contract } = req.app.get("models");
  const { id } = req.params;
  const contract = await Contract.findOne({ where: { id } });
  if (!contract) return res.status(404).end("Not found!");
  if (req.profile.id != contract.ContractorId)
    return res.status(401).end("Profile doesn't match with contractor");
  res.json(contract);
});

app.get("/contracts", getProfile, async (req, res) => {
  const { Contract } = req.app.get("models");

  const contracts = await Contract.findAll({
    where: {
      [Op.or]: [
        { ContractorId: { [Op.eq]: req.profile.id } },
        { clientId: { [Op.eq]: req.profile.id } },
      ],
      status: { [Op.not]: StatusEnum.TERMINATED },
    },
  });
  res.json(contracts);
});

app.get("/jobs/unpaid", getProfile, async (req, res) => {
  const { Job, Contract } = req.app.get("models");

  const unpaidJobs = await Job.findAll({
    where: { paid: null },
    include: [
      {
        model: Contract,
        where: { status: { [Op.not]: StatusEnum.TERMINATED } },
      },
    ],
  });

  res.json(unpaidJobs);
});

app.get("/admin/best-profession", getProfile, async (req, res) => {
  const { Job, Contract, Profile } = req.app.get("models");
  const { start, end } =
    req.query || moment(Date(), "YYYY-MM-DD").startOf("day");

  const bestPayedWorks = await Job.findOne({
    where: {
      paid: 1,
      paymentDate: {
        [Op.between]: [
          moment(start, "YYYY-MM-DD").startOf("day"),
          moment(end, "YYYY-MM-DD").startOf("day"),
        ],
      },
    },
    attributes: [
      "paymentDate",
      [sequelize.fn("sum", sequelize.col("price")), "sum_of_price"],
    ],
    include: {
      model: Contract,
      include: {
        model: Profile,
        as: "Contractor",
        attributes: ["profession"],
        where: { type: "contractor" },
      },
    },
    group: ["Contract.Contractor.profession"],
    order: [["sum_of_price", "DESC"]],
  });

  if (!bestPayedWorks) return res.status(404).json({ message: "No results" });

  res.json(bestPayedWorks);
});

app.get("/admin/best-clients", getProfile, async (req, res) => {
  const { Job, Contract, Profile } = req.app.get("models");
  const { limit } = req.query || 2;
  const { start, end } =
    req.query || moment(Date(), "YYYY-MM-DD").startOf("day");

  const bestClientsPayments = await Job.findAll({
    where: {
      paid: 1,
      paymentDate: {
        [Op.between]: [
          moment(start, "YYYY-MM-DD").startOf("day"),
          moment(end, "YYYY-MM-DD").startOf("day"),
        ],
      },
    },
    attributes: [
      "paymentDate",
      [sequelize.fn("sum", sequelize.col("price")), "sum_of_jobs"],
    ],
    include: {
      model: Contract,
      include: {
        model: Profile,
        as: "Client",
        where: { type: "client" },
      },
    },
    limit,
    group: ["Contract.Client.id"],
    order: [["sum_of_jobs", "DESC"]],
  });

  console.log(bestClientsPayments[0].dataValues.sum_of_jobs);
  res.json(
    bestClientsPayments.map((job) => ({
      id: job.Contract.Client.id,
      fullName: `${job.Contract.Client.firstName} ${job.Contract.Client.lastName} `,
      paid: job?.dataValues?.sum_of_jobs | 0,
    }))
  );
});

app.post("/balances/deposit/:userId", getProfile, async (req, res) => {
  const { Job, Contract, Profile } = req.app.get("models");
  const { balance } = req.body;
  const { userId } = req.params;

  if (!balance) return res.status(400).json({ message: "Invalid balance" });

  const pendingPayments = await Job.sum("price", {
    include: [
      {
        model: Contract,
        where: {
          status: { [Op.not]: StatusEnum.TERMINATED },
          clientId: userId,
        },
      },
    ],
  });

  const maxBalanceToDeposit = pendingPayments * (25 / 100);

  if (balance > maxBalanceToDeposit)
    return res.status(401).json({
      message: `Deposit balance must be less than 25% of pending jobs to pay, max balance to deposit: $${maxBalanceToDeposit}`,
      maxBalanceToDeposit,
    });

  const updateClientBalance = await Profile.increment(
    { balance },
    { where: { id: userId } }
  );

  res.json({ message: "sucessful!", updateClientBalance });
});

app.post("/jobs/:jobId/pay", getProfile, async (req, res) => {
  const { Job, Contract, Profile } = req.app.get("models");

  try {
    const jobToPay = await Job.findOne({
      where: { id: req.params.jobId, paid: null },
      include: {
        model: Contract,
        include: [
          { model: Profile, as: "Client" },
          { model: Profile, as: "Contractor" },
        ],
        where: { status: { [Op.not]: StatusEnum.TERMINATED } },
      },
    });

    if (jobToPay.Contract.Client.balance < jobToPay.price)
      return res.json({
        message:
          "The customer does not have sufficient balance to pay this contract.",
      });

    const payJobResult = await sequelize.transaction(async (t) => {
      const newClientBalance =
        jobToPay.Contract.Client.balance - jobToPay.price;
      const newContractorBalance =
        jobToPay.Contract.Contractor.balance + jobToPay.price;

      const updateClientBalance = await Profile.update(
        { balance: newClientBalance },
        { where: { id: jobToPay.Contract.Client.id } },
        { transaction: t }
      );
      const updateContractorBalance = await Profile.update(
        { balance: newContractorBalance },
        { where: { id: jobToPay.Contract.Contractor.id } },
        { transaction: t }
      );

      const updateContract = await Contract.update(
        { paid: 1 },
        { where: { id: jobToPay.Contract.id } },
        { transaction: t }
      );

      return { updateClientBalance, updateContractorBalance, updateContract };
    });

    res.json({ message: "sucessful!", payJobResult });
  } catch (error) {
    //Auto rollback
    res.json({ message: error.message });
  }
});

module.exports = app;
