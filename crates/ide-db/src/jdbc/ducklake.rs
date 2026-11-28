use super::{DbJdbcDriver, JdbcPool};
use crate::source::{DUCKDB_URL, duck_lake_path};
use crate::{DataSource, DbDuckLake, DbDuckLakeKind, DbManager, Pool};
use ide_core::{IdeError, IdeResult};

const DUCKDB_CLASS: &str = "org.duckdb.DuckDBDriver";

impl DbManager {
    pub fn approve_ducklake_source(&self, source: &DataSource) -> IdeResult<()> {
        if source.duck_lake.is_none() {
            return Err(IdeError::invalid("Expected a DuckLake data source"));
        }
        source.validate_duck_lake()?;
        self.duck_lake_driver(&source.jdbc_driver)?.validate()?;
        if source.global {
            return Ok(());
        }
        self.record_jdbc_approval(source)
    }

    fn duck_lake_driver(&self, id: &str) -> IdeResult<DbJdbcDriver> {
        let driver = self.jdbc_driver_by_id(id)?;
        driver.require_vendor("duckdb")?;
        if driver.class_name != DUCKDB_CLASS {
            return Err(IdeError::invalid("Select a DuckDB driver profile with the official DuckDB JDBC driver class"));
        }
        Ok(driver)
    }

    /// Creates a lake in a new directory through a separate, disposable JDBC session.
    pub async fn create_ducklake(&self, jdbc_driver: &str, directory: &str) -> IdeResult<()> {
        duck_lake_path(directory, false)?;
        let driver = self.duck_lake_driver(jdbc_driver)?;
        let fields = duck_lake_fields("create", directory.to_owned(), "");
        let pool = JdbcPool::open(driver, self.jdbc_registry()?.with_file_name("jdbc"), fields).await?;
        pool.close().await;
        Ok(())
    }

    pub(super) async fn open_ducklake(&self, source: &DataSource, lake: &DbDuckLake, testing: bool) -> IdeResult<Pool> {
        source.validate_duck_lake()?;
        self.check_jdbc_project_approval(source, testing)?;
        let driver = self.duck_lake_driver(&source.jdbc_driver)?;
        let cache = self.jdbc_registry()?.with_file_name("jdbc");
        let (mode, value) = match lake.kind {
            DbDuckLakeKind::Secret => ("secret", lake.value.clone()),
            DbDuckLakeKind::File => {
                let path = self.root.join(&lake.value);
                let value = path.to_str().ok_or_else(|| IdeError::invalid("Invalid DuckLake catalog file path"))?;
                duck_lake_path(value, false)?;
                ("file", value.to_owned())
            }
        };
        let fields = duck_lake_fields(mode, value, lake.data_path.as_deref().unwrap_or_default());
        JdbcPool::open(driver, cache, fields).await.map(Box::new).map(Pool::Jdbc)
    }
}

fn duck_lake_fields(mode: &str, value: String, data_path: &str) -> Vec<String> {
    vec![
        "openDuckLake".into(),
        DUCKDB_CLASS.into(),
        DUCKDB_URL.into(),
        String::new(),
        String::new(),
        (mode != "create").to_string(),
        mode.into(),
        value,
        data_path.to_owned(),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn ordinary_jdbc_rejects_a_ducklake_even_with_a_file_url() {
        let source = DataSource {
            driver: crate::DbDriver::Jdbc,
            url: "jdbc:duckdb:existing.duckdb".into(),
            duck_lake: Some(DbDuckLake {
                kind: DbDuckLakeKind::File,
                value: "catalog.ducklake".into(),
                data_path: None,
            }),
            ..Default::default()
        };
        let driver = DbJdbcDriver {
            id: "duckdb".into(),
            name: "DuckDB".into(),
            vendor: Some("duckdb".into()),
            jars: vec![],
            class_name: DUCKDB_CLASS.into(),
            url_template: DUCKDB_URL.into(),
        };
        let error = JdbcPool::connect(&source, None, driver, Default::default())
            .await
            .err()
            .expect("ordinary JDBC must reject DuckLake fields before opening a connection");
        assert_eq!(error.message, "DuckLake catalogs require a DuckLake connection");
    }
}
