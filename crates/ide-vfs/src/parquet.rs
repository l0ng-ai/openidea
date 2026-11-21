use arrow_array::RecordBatch;
use arrow_cast::display::{ArrayFormatter, FormatOptions};
use ide_core::{IdeError, IdeResult};
use parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::BTreeSet;
use std::fs::File;
use std::path::Path;

const PAGE_ROWS: usize = 100;
const PAGE_CELLS: usize = 4_096;
const CELL_BYTES: usize = 1_024;

#[derive(Debug, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ParquetColumn {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
}

#[derive(Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ParquetPage {
    pub columns: Vec<ParquetColumn>,
    pub rows: Vec<Vec<Option<String>>>,
    pub total_rows: u64,
    pub row_groups: usize,
    pub page_size: usize,
    pub size: u64,
    pub compression: Vec<String>,
}

pub fn read_parquet_page(path: &Path, offset: u64) -> IdeResult<ParquetPage> {
    let file = File::open(path)?;
    let size = file.metadata()?.len();
    let invalid = |error: parquet::errors::ParquetError| IdeError::invalid(error.to_string());
    let builder = ParquetRecordBatchReaderBuilder::try_new(file).map_err(invalid)?;
    let metadata = builder.metadata();
    let columns: Vec<_> = builder
        .schema()
        .fields()
        .iter()
        .map(|field| ParquetColumn {
            name: field.name().clone(),
            data_type: field.data_type().to_string(),
            nullable: field.is_nullable(),
        })
        .collect();
    let compression = metadata
        .row_groups()
        .iter()
        .flat_map(|group| group.columns().iter().map(|column| format!("{:?}", column.compression_codec())))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let limit = PAGE_ROWS.min((PAGE_CELLS / columns.len().max(1)).max(1));
    let mut page = ParquetPage {
        columns,
        rows: Vec::new(),
        total_rows: metadata
            .file_metadata()
            .num_rows()
            .try_into()
            .map_err(|_| IdeError::invalid("Invalid Parquet row count"))?,
        row_groups: metadata.num_row_groups(),
        page_size: limit,
        size,
        compression,
    };
    if offset >= page.total_rows {
        return Ok(page);
    }

    let mut skip = usize::try_from(offset).map_err(|_| IdeError::invalid("Invalid Parquet row offset"))?;
    let mut remaining = limit;
    let mut groups = Vec::new();
    for index in 0..metadata.num_row_groups() {
        let rows = metadata.row_group_num_rows(index).map_err(invalid)?;
        if groups.is_empty() && skip >= rows {
            skip -= rows;
            continue;
        }
        remaining = remaining.saturating_sub(if groups.is_empty() { rows - skip } else { rows });
        groups.push(index);
        if remaining == 0 {
            break;
        }
    }
    let reader = builder
        .with_row_groups(groups)
        .with_offset(skip)
        .with_limit(limit)
        .with_batch_size(limit)
        .build()
        .map_err(invalid)?;
    for batch in reader {
        append_rows(&batch.map_err(|error| IdeError::invalid(error.to_string()))?, &mut page.rows)?;
    }
    Ok(page)
}

fn append_rows(batch: &RecordBatch, rows: &mut Vec<Vec<Option<String>>>) -> IdeResult<()> {
    let options = FormatOptions::default();
    let formatters = batch
        .columns()
        .iter()
        .map(|column| ArrayFormatter::try_new(column.as_ref(), &options))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| IdeError::invalid(error.to_string()))?;
    rows.extend((0..batch.num_rows()).map(|row| {
        batch
            .columns()
            .iter()
            .zip(&formatters)
            .map(|(column, formatter)| {
                if column.is_null(row) {
                    return None;
                }
                let mut value = formatter.value(row).to_string();
                if value.len() > CELL_BYTES {
                    value.truncate(value.floor_char_boundary(CELL_BYTES));
                    value.push('…');
                }
                Some(value)
            })
            .collect()
    }));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use arrow_array::{Array, StringArray, TimestampMicrosecondArray, UInt64Array};
    use parquet::{arrow::ArrowWriter, basic::Compression, file::properties::WriterProperties};
    use std::sync::Arc;

    #[test]
    fn reads_a_page_across_row_groups_and_preserves_types_and_nulls() {
        let file = tempfile::NamedTempFile::new().unwrap();
        let high = 9_007_199_254_740_992;
        let ids = UInt64Array::from_iter_values(high..high + 220);
        let names = StringArray::from_iter((0..220).map(|row| (row != 65).then_some("value")));
        let timestamps = TimestampMicrosecondArray::from_value(0, 220).with_timezone("UTC");
        let midnight = "1970-01-01T00:00:00Z";
        let batch = RecordBatch::try_from_iter([
            ("id", Arc::new(ids) as Arc<dyn Array>),
            ("name", Arc::new(names)),
            ("timestamp", Arc::new(timestamps)),
        ])
        .unwrap();
        let properties = WriterProperties::builder()
            .set_max_row_group_row_count(Some(65))
            .set_compression(Compression::ZSTD(Default::default()))
            .build();
        let mut writer = ArrowWriter::try_new(file.reopen().unwrap(), batch.schema(), Some(properties)).unwrap();
        writer.write(&batch).unwrap();
        writer.close().unwrap();

        let page = read_parquet_page(file.path(), 64).unwrap();
        assert_eq!(page.total_rows, 220);
        assert_eq!(page.row_groups, 4);
        assert_eq!(page.size, file.as_file().metadata().unwrap().len());
        assert_eq!(page.compression, ["ZSTD"]);
        assert_eq!(
            page.columns,
            [
                ParquetColumn { name: "id".into(), data_type: "UInt64".into(), nullable: false },
                ParquetColumn { name: "name".into(), data_type: "Utf8".into(), nullable: true },
                ParquetColumn {
                    name: "timestamp".into(), data_type: "Timestamp(µs, \"UTC\")".into(), nullable: false
                },
            ]
        );
        assert_eq!(
            page.rows,
            (64..164)
                .map(|row| vec![
                    Some((high + row).to_string()),
                    (row != 65).then(|| "value".into()),
                    Some(midnight.into())
                ])
                .collect::<Vec<_>>()
        );
        assert_eq!(
            read_parquet_page(file.path(), 219).unwrap().rows,
            [vec![Some((high + 219).to_string()), Some("value".into()), Some(midnight.into())]]
        );
        assert!(read_parquet_page(file.path(), 220).unwrap().rows.is_empty());
    }
}
