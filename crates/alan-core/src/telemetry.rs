use tracing_subscriber::{fmt, layer::SubscriberExt, EnvFilter, Registry};

pub fn init_logging(json: bool) -> anyhow::Result<()> {
    let filter =
        EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("alan=info"));

    if json {
        let subscriber = Registry::default().with(filter).with(fmt::layer().json());
        tracing::subscriber::set_global_default(subscriber)?;
    } else {
        let subscriber = Registry::default().with(filter).with(fmt::layer().pretty());
        tracing::subscriber::set_global_default(subscriber)?;
    }

    Ok(())
}
